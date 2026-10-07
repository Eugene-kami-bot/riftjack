#!/usr/bin/env python3
"""Riftjack pull worker client. Python standard library only; JSON on stdout."""
import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a worker token to a redirected destination.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.getenv('RIFTJACK_WORKER_URL', 'http://127.0.0.1:8788'))
    parser.add_argument('--bot', default=os.getenv('RIFTJACK_WORKER_BOT'))
    parser.add_argument('--token-file', default=os.getenv('RIFTJACK_WORKER_TOKEN_FILE'))
    sub = parser.add_subparsers(dest='command', required=True)
    wait = sub.add_parser('wait'); wait.add_argument('--seconds', type=int, default=300)
    for name in ['status', 'renew', 'release', 'reply', 'attachment']:
        cmd = sub.add_parser(name)
        cmd.add_argument('task', help='Task JSON file saved from wait')
        if name == 'reply':
            cmd.add_argument('--text-file', help='UTF-8 reply text')
            cmd.add_argument('--file', action='append', default=[], help='Attach a local file; repeat up to 10 times')
        if name == 'attachment': cmd.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.url)
    if url.username or url.password or url.query or url.fragment or url.scheme not in ('https', 'http'):
        parser.error('Use an HTTPS base URL, or HTTP on loopback through an SSH tunnel.')
    if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('Plain HTTP is allowed only on loopback.')
    if not args.bot or not args.token_file: parser.error('--bot and --token-file are required')
    token = Path(args.token_file).read_text().strip()
    opener = urllib.request.build_opener(NoRedirect())
    endpoint = args.url.rstrip('/') + '/v1/bots/' + urllib.parse.quote(args.bot, safe='') + '/tasks'

    def request(path='', body=None):
        req = urllib.request.Request(endpoint + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=650 if args.command == 'attachment' else 45) as response:
            return json.load(response)

    if args.command == 'wait':
        if args.seconds < 1: parser.error('--seconds must be positive')
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            result = request('?wait=' + str(min(30, max(1, math.ceil(deadline - time.monotonic())))))
            if result.get('task'):
                print(json.dumps(result['task'], ensure_ascii=False)); return
        print(json.dumps({'timeout': True})); return
    task = json.loads(Path(args.task).read_text())
    task_id = urllib.parse.quote(task['id'], safe='')
    body = {'lease': task['lease']}
    if args.command == 'reply':
        body['text'] = Path(args.text_file).read_text() if args.text_file else ''
        body['files'] = [{'name': Path(p).name, 'data': base64.b64encode(Path(p).read_bytes()).decode()} for p in args.file]
    path = '/' + task_id + ('' if args.command == 'status' else '/' + args.command)
    result = request(path, None if args.command == 'status' else body)
    if args.command == 'attachment':
        output = Path(args.output)
        with output.open('xb') as file:
            os.chmod(output, 0o600)
            file.write(base64.b64decode(result['data'], validate=True))
        result = {'saved': str(output), 'name': result['name'], 'mimetype': result['mimetype'],
                  **({'transcription': result['transcription']} if 'transcription' in result else {})}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        try: message = json.loads(error.read()).get('error', 'Worker request rejected')
        except (ValueError, AttributeError): message = 'Worker request rejected'
        print(json.dumps({'status': error.code, 'error': message}), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
