#!/usr/bin/env python3
"""Riftjack pull worker client. Python standard library only; JSON on stdout."""
import argparse
import base64
import json
import math
import os
import sqlite3
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
    parser.add_argument('--nerve-db', default=os.getenv('RIFTJACK_NERVE_DB'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('mcp', help='Serve linked-room actions as a stdio MCP tool')
    wait = sub.add_parser('wait'); wait.add_argument('--seconds', type=int, default=300)
    sub.add_parser('rooms')
    send = sub.add_parser('send')
    send.add_argument('--room', required=True)
    send.add_argument('--text-file', required=True, help='UTF-8 message text')
    send.add_argument('--id', required=True, help='Durable idempotency key')
    recipients = send.add_mutually_exclusive_group()
    recipients.add_argument('--mention', action='store_true', help='Mention the sole peer in a two-agent room')
    recipients.add_argument('--mentions', action='append', default=[], help='Mention an exact peer Matrix ID; repeat as needed')
    send.add_argument('--owner-turn-id', help='Durable ID of the authenticated human event that authorized this cross-channel send')
    send.add_argument('--owner-turn-time', type=int, help='Unix milliseconds when that human event was accepted')
    send.add_argument('--owner-session', help='Nerve session ID whose latest Telegram user message authorized this send')
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
    root = args.url.rstrip('/') + '/v1/bots/' + urllib.parse.quote(args.bot, safe='')
    endpoint = root + '/tasks'

    def request(path='', body=None):
        req = urllib.request.Request(endpoint + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=650 if args.command == 'attachment' else 45) as response:
            return json.load(response)

    def request_body(target, body):
        req = urllib.request.Request(target, data=json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=45) as response:
            return json.load(response)

    def nerve_owner_turn(session):
        if not args.nerve_db: raise ValueError('--nerve-db or RIFTJACK_NERVE_DB is required with owner_session')
        allowed_sources = {item.strip() for item in os.getenv('RIFTJACK_OWNER_SOURCES', 'telegram').split(',') if item.strip()}
        db = sqlite3.connect('file:' + urllib.parse.quote(str(Path(args.nerve_db).resolve())) + '?mode=ro', uri=True)
        try:
            row = db.execute("""SELECT m.id, m.created_at, s.source FROM messages m JOIN sessions s ON s.id=m.session_id
                WHERE m.session_id=? AND m.role='user' ORDER BY m.id DESC LIMIT 1""", (session,)).fetchone()
        finally: db.close()
        if not row or row[2] not in allowed_sources: raise ValueError('the session has no accepted user message from an allowed owner source')
        stamp = row[1].replace(' ', 'T')
        if not stamp.endswith(('Z', '+00:00')): stamp += 'Z'
        from datetime import datetime
        return {'id': 'nerve:' + row[2] + ':' + session + ':' + str(row[0]),
                'time': int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000)}

    if args.command == 'mcp':
        tool = {'name': 'room_messages', 'description': 'List linked Matrix rooms, send an encrypted message, or issue one bounded managed-review request. '
            'A mentioning send prompted by the owner in Telegram must include the current Nerve owner_session; peer, timer and background turns must omit it. '
            'Background review supervision must use request_review, which starts only its exact reviewers and grants no general peer credit.',
            'inputSchema': {'type': 'object', 'properties': {
                'action': {'type': 'string', 'enum': ['list', 'send', 'request_review']}, 'room': {'type': 'string'}, 'text': {'type': 'string'},
                'id': {'type': 'string'}, 'mention': {'type': 'boolean'}, 'mentions': {'type': 'array', 'items': {'type': 'string'}},
                'owner_session': {'type': 'string'}, 'review_id': {'type': 'string'}, 'repository': {'type': 'string'},
                'pull_request': {'type': 'integer'}, 'sha': {'type': 'string'}, 'reviewers': {'type': 'array', 'items': {'type': 'string'}}},
                'required': ['action'], 'additionalProperties': False},
            'annotations': {'destructiveHint': False, 'openWorldHint': True}}
        for line in sys.stdin:
            message = {}
            try:
                message = json.loads(line); request_id = message.get('id'); method = message.get('method')
                if request_id is None: continue
                if method == 'initialize': result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'riftjack-worker-rooms', 'version': '1.0.0'}}
                elif method == 'ping': result = {}
                elif method == 'tools/list': result = {'tools': [tool]}
                elif method == 'tools/call' and message.get('params', {}).get('name') == 'room_messages':
                    body = dict(message.get('params', {}).get('arguments') or {})
                    owner_session = body.pop('owner_session', None)
                    if owner_session is not None: body['owner_turn'] = nerve_owner_turn(owner_session)
                    value = request_body(root + '/rooms', body)
                    result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
                else:
                    print(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32601, 'message': 'Method not found.'}}), flush=True); continue
                print(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'result': result}, ensure_ascii=False), flush=True)
            except Exception as error:
                print(json.dumps({'jsonrpc': '2.0', 'id': message.get('id') if isinstance(message, dict) else None,
                    'result': {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}}), flush=True)
        return

    if args.command == 'wait':
        if args.seconds < 1: parser.error('--seconds must be positive')
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            result = request('?wait=' + str(min(30, max(1, math.ceil(deadline - time.monotonic())))))
            if result.get('task'):
                print(json.dumps(result['task'], ensure_ascii=False)); return
        print(json.dumps({'timeout': True})); return
    if args.command == 'rooms':
        print(json.dumps(request_body(root + '/rooms', {'action': 'list'}), ensure_ascii=False)); return
    if args.command == 'send':
        if not (args.owner_turn_id is None) == (args.owner_turn_time is None):
            parser.error('--owner-turn-id and --owner-turn-time must be supplied together')
        if args.owner_session and args.owner_turn_id is not None:
            parser.error('choose --owner-session or explicit --owner-turn-id/--owner-turn-time')
        if args.owner_session:
            try:
                derived = nerve_owner_turn(args.owner_session)
            except ValueError as error: parser.error(str(error))
            args.owner_turn_id, args.owner_turn_time = derived['id'], derived['time']
        body = {'action': 'send', 'room': args.room, 'text': Path(args.text_file).read_text(), 'id': args.id}
        if args.mention: body['mention'] = True
        if args.mentions: body['mentions'] = args.mentions
        if args.owner_turn_id is not None: body['owner_turn'] = {'id': args.owner_turn_id, 'time': args.owner_turn_time}
        print(json.dumps(request_body(root + '/rooms', body), ensure_ascii=False)); return
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
