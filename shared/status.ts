import { SessionStatus } from '@microsoft/agent-host-protocol';

export type Phase = 'input' | 'running' | 'error' | 'idle';

/** SessionStatus — битовая маска: InputNeeded включает в себя бит InProgress. */
export function phaseOf(status: number): Phase {
  if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) return 'input';
  if (status & SessionStatus.InProgress) return 'running';
  if (status & SessionStatus.Error) return 'error';
  return 'idle';
}

export function isArchived(status: number): boolean {
  return (status & SessionStatus.IsArchived) !== 0;
}
