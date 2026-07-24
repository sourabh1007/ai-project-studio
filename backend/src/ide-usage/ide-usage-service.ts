import type { IdeUsage, IdeUsageReader } from './ide-usage-contract.js';

/** Assembles the IDE AI-usage payload from the meta-session read port. */
export interface IdeUsageService {
  read(): IdeUsage;
}

export interface IdeUsageServiceDeps {
  reader: IdeUsageReader;
}

export function createIdeUsageService(
  deps: IdeUsageServiceDeps,
): IdeUsageService {
  return {
    read() {
      return {
        totals: deps.reader.totals(),
        byModel: deps.reader.byModel(),
        byDay: deps.reader.byDay(),
      };
    },
  };
}
