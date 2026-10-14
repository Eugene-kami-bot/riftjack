import { startToolMcp } from './tool-mcp.js';
import { publishInput } from './publish.js';

export type PublishAction = (input: unknown, signal: AbortSignal) => Promise<string>;
export type PublishConnection = { url: string; headers: { Authorization: string } };
export const PUBLISH_SERVER = 'riftjack_publish';
export const PUBLISH_TOOL = 'mcp__riftjack_publish__prepare_publish';
export const publicationInstructions = '\nFor Git publication, call the Riftjack prepare_publish MCP tool with repository, remote and branch. Commit intended changes first. The tool sends a complete HTML review to this Matrix conversation, waits for explicit human approval, and only then pushes the reviewed commits. Do not substitute a shell push or treat ordinary chat as approval. Respect an explicit human decline or cancellation; request renewed permission before another review. After a technical interruption or lost result, check the destination and whether the previous request is still active. If already published, report it without repeating. If not published and no request remains active, prepare a fresh review within the authorized task without waiting for another invitation. If the outcome or cancellation reason cannot be established, report the blocker and ask for clarification. Every new review requires fresh human approval; never reuse an expired confirmation.';

const tool = {
  name: 'prepare_publish',
  description: 'Prepare and deliver an HTML review of committed Git changes to the current Matrix conversation, wait for human approval, then publish exactly those commits. This call may wait for up to the task timeout. Respect human declines and cancellations. After a technical interruption, verify the destination and that no previous request remains active before preparing a fresh review with fresh human approval. Do not repeat a completed push; clarify unresolved state before retrying.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { repository: { type: 'string', description: 'Git repository path within the bot workspace.' }, remote: { type: 'string', description: 'Named Git remote, for example origin.' }, branch: { type: 'string', description: 'Destination branch, for example main.' } },
    required: ['repository', 'remote', 'branch'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
export function startPublishMcp(publish: PublishAction, signal: AbortSignal) {
  return startToolMcp(tool, (input, callSignal) => publish(publishInput(input), callSignal), signal, {
    server: 'riftjack-publish',
    cancelled: 'Publication cancelled or interrupted. A push already in progress may have completed. Check the destination and previous request before retrying. Respect human cancellation; after a technical interruption, an unpublished change may receive a fresh review once no request remains active. Fresh human approval is required.',
    failed: 'Publication failed. Check the destination before attempting another reviewed request.',
  });
}
