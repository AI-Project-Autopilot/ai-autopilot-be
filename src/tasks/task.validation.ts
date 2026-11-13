import { BadRequestException } from '@nestjs/common';
import { TaskUpdate } from './task.types';

export function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^c[a-z0-9]{24}$/.test(value))
    throw new BadRequestException('The task or analysis ID must be a valid ID.');
  return value;
}

export function repositoryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value))
    throw new BadRequestException('repositoryId must be a positive GitHub repository ID.');
  return value;
}

export function requestObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BadRequestException('The task request must be a JSON object.');
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new BadRequestException('The task request contains unsupported fields.');
  return value as Record<string, unknown>;
}

export function taskUpdate(value: unknown): TaskUpdate {
  const input = requestObject(value, ['title', 'body', 'status']);
  if (Object.keys(input).length === 0)
    throw new BadRequestException('Provide a title, body, or status to update.');
  const patch: TaskUpdate = {};
  if ('title' in input) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      throw new BadRequestException('title must be a nonempty string of at most 200 characters.');
    patch.title = input.title.trim();
  }
  if ('body' in input) {
    if (typeof input.body !== 'string' || input.body.length > 30000)
      throw new BadRequestException('body must be a string of at most 30000 characters.');
    patch.body = input.body;
  }
  if ('status' in input) {
    if (
      typeof input.status !== 'string' ||
      !['selected', 'in_progress', 'completed', 'cancelled'].includes(input.status)
    )
      throw new BadRequestException(
        'status must be selected, in_progress, completed, or cancelled.'
      );
    patch.status = input.status as TaskUpdate['status'];
  }
  return patch;
}
