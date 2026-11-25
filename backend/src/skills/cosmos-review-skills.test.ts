import { describe, expect, it } from 'vitest';
import { COSMOS_REVIEW_SKILLS, selectCosmosReviewSkillIds } from './cosmos-review-skills.js';
import type { Skill } from './skills-contract.js';

const skills: Skill[] = COSMOS_REVIEW_SKILLS.map((skill, index) => ({
  ...skill, id: `cosmos-${index}`, removalInstructions: '', recommendedScope: 'feature', createdAt: '',
}));
const input = {
  repository: 'https://dev.azure.com/example/project/_git/CosmosDB', description: '', skills,
  nodes: [] as Array<{ kind: string; path: string; diff: string }>, maxFiles: 100, maxChars: 10000,
};
const names = (ids: string[]) => skills.filter((skill) => ids.includes(skill.id)).map((skill) => skill.name);

describe('relevant Cosmos DB IDE guidance', () => {
  it('selects native authorization, markers and tests without adding unrelated query/feed guidance', () => {
    const selected = names(selectCosmosReviewSkillIds({ ...input, description: 'Require system auth for background markers',
      nodes: [{ kind: 'changed', path: 'Product/Backend/native/BaseResourceHandlerTests.cpp', diff: '+ValidateAuth(marker);' },
        { kind: 'boundary', path: 'QueryIndex.cpp', diff: 'unchanged change feed' }] }));
    expect(selected).toContain('Cosmos DB: Authentication and trust boundaries');
    expect(selected).toContain('Cosmos DB: Background operations and internal markers');
    expect(selected).toContain('Cosmos DB: Native lifetime and asynchronous ownership');
    expect(selected).toContain('Cosmos DB: Regression tests and operational diagnostics');
    expect(selected).not.toContain('Cosmos DB: Query and indexing efficiency');
    expect(selected).not.toContain('Cosmos DB: Change feed and checkpoint recovery');
  });
  it('does not attach Cosmos guidance to unrelated repositories, but recognizes captured Cosmos SDK usage', () => {
    const unrelated = { ...input, repository: 'https://github.com/example/shop', description: 'Handle retries' };
    expect(selectCosmosReviewSkillIds(unrelated)).toEqual([]);
    const selected = names(selectCosmosReviewSkillIds({ ...unrelated,
      nodes: [{ kind: 'changed', path: 'CosmosClient.cs', diff: '+ReadNextAsync(sessionToken);' }] }));
    expect(selected).toContain('Cosmos DB: Consistency and replication');
    expect(selected).toContain('Cosmos DB: RU throttling and bounded retries');
  });
  it('selects only available instruction skills and preserves customized guidance', () => {
    const customized = { ...skills[1]!, instructions: 'Our pinned auth checklist.' };
    const available = [customized, { ...skills[2]!, kind: 'task-plan' as const }, { ...skills[0]!, name: 'Unrelated skill' }];
    expect(selectCosmosReviewSkillIds({ ...input, skills: available, description: 'auth HTTP' })).toEqual([customized.id]);
    expect(customized.instructions).toBe('Our pinned auth checklist.');
    expect(selectCosmosReviewSkillIds(input)).toEqual([skills[0]!.id]);
  });
  it('bounds matching work by file count and total characters, not by clipping review evidence', () => {
    const nodes = [{ kind: 'changed', path: 'a.cs', diff: '+auth' }, { kind: 'changed', path: 'b.cs', diff: '+query' }];
    expect(names(selectCosmosReviewSkillIds({ ...input, nodes, maxFiles: 1 }))).not.toContain('Cosmos DB: Query and indexing efficiency');
    expect(names(selectCosmosReviewSkillIds({ ...input, nodes, description: 'auth '.repeat(100), maxChars: 10 })))
      .not.toContain('Cosmos DB: Query and indexing efficiency');
    expect(nodes[1]!.diff).toBe('+query');
  });
});
