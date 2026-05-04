import type { Page } from 'playwright';
import type { SemanticNode } from './types.js';
export declare class SemanticExtractor {
    static extract(page: Page, intent?: string): Promise<{
        tree: SemanticNode;
        tokensSaved: number;
    }>;
}
//# sourceMappingURL=SemanticExtractor.d.ts.map