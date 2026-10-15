import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/api', () => ({ api: {}, errorMessage: String }));
import type { GitHubRepository } from '../../../shared/github';
import { rank } from './GitHubPicker';

const repo = (fullName: string, id: number) => ({ id, fullName, name: fullName.split('/')[1], private: false }) as GitHubRepository;

describe('GitHub picker order', () => {
  it('puts the repository named as asked first, then names starting with it, then names holding it, keeping GitHub’s order otherwise', () => {
    const list = [repo('ACM-VIT/website', 1), repo('ACM-VIT/old-examcooker', 2), repo('ACM-VIT/examcooker-api', 3), repo('ACM-VIT/ExamCooker', 4), repo('ACM-VIT/docs', 5)];
    expect(rank(list, 'examcooker').map(item => item.id)).toEqual([4, 3, 2, 1, 5]);
    expect(rank(list, '')).toBe(list);
  });
});
