import type { Page } from 'playwright';
import type { SemanticNode, SemanticLens } from './types.js';

export class SemanticExtractor {
  static async extract(page: Page, intent?: string, lens: SemanticLens = 'UX'): Promise<{ tree: SemanticNode, tokensSaved: number }> {
    const rawTree = await page.evaluate((lensName) => {
      let idCounter = 0;

      function generateId(element: Element): string {
        let existingId = element.getAttribute('data-splice-id');
        if (existingId) return existingId;
        idCounter++;
        const tagName = element.tagName.toLowerCase();
        existingId = `${tagName}-${idCounter}`;
        element.setAttribute('data-splice-id', existingId);
        return existingId;
      }

      function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0' &&
               rect.width > 0 && 
               rect.height > 0;
      }

      function processNode(node: Element, depth: number = 0): SemanticNode[] {
        const isNodeVisible = isVisible(node);
        const tagName = node.tagName.toLowerCase();
        
        // Lens specific visibility rules
        if (!isNodeVisible && lensName !== 'Security') {
          return []; // Security lens cares about hidden inputs/scripts
        }

        const excludeTags = ['style', 'noscript', 'meta', 'link', 'head', 'svg', 'iframe', 'canvas'];
        if (excludeTags.includes(tagName)) return [];
        if (tagName === 'script' && lensName !== 'Security') return []; // Only Security cares about scripts

        const children: SemanticNode[] = [];
        for (const child of Array.from(node.children)) {
          children.push(...processNode(child, depth + 1));
        }

        const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(tagName) || 
                              node.getAttribute('role') === 'button' || 
                              node.getAttribute('role') === 'link';

        const isTextElement = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'div', 'label', 'li', 'td', 'th'].includes(tagName);
        
        let directText = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            directText += child.textContent;
          }
        }
        directText = directText.replace(/\s+/g, ' ').trim();

        const hasAria = node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby');

        // Extraction conditions based on lens
        let shouldExtract = false;
        const securityFlags: string[] = [];
        const performanceMetrics: any = {};

        if (lensName === 'Security') {
          if (tagName === 'script' && node.hasAttribute('src')) {
            securityFlags.push('external-script');
            shouldExtract = true;
          }
          if (tagName === 'input' && (node as HTMLInputElement).type === 'password') {
            securityFlags.push('password-input');
            shouldExtract = true;
          }
          if (tagName === 'input' && (node as HTMLInputElement).type === 'hidden') {
            securityFlags.push('hidden-input');
            shouldExtract = true;
          }
          if (tagName === 'form') {
            const action = node.getAttribute('action') || '';
            if (action.startsWith('http://')) securityFlags.push('insecure-form');
            shouldExtract = true;
          }
        } else if (lensName === 'Performance') {
          if (tagName === 'img') {
            const rect = node.getBoundingClientRect();
            if (rect.width * rect.height > 100000) performanceMetrics.isLargeImage = true;
            shouldExtract = true;
          }
          if (depth > 20) {
            performanceMetrics.depth = depth;
            shouldExtract = true;
          }
        } else {
          // Default UX Lens
          if (isInteractive || (isTextElement && directText.length > 0) || tagName === 'img' || hasAria) {
            shouldExtract = true;
          }
        }

        if (shouldExtract) {
          const id = generateId(node);
          const semanticNode: SemanticNode = {
            id,
            type: isInteractive ? 'interactive' : (tagName === 'script' || tagName === 'form' ? 'technical' : 'content'),
            attributes: {
              tagName: tagName
            }
          };

          if (directText) semanticNode.text = directText;
          if (node.getAttribute('aria-label')) semanticNode.attributes!['aria-label'] = node.getAttribute('aria-label')!;
          if (node.getAttribute('placeholder')) semanticNode.attributes!['placeholder'] = node.getAttribute('placeholder')!;
          if (tagName === 'a' && node.getAttribute('href')) semanticNode.attributes!['href'] = node.getAttribute('href')!;
          if (tagName === 'input' && node.getAttribute('type')) semanticNode.attributes!['type'] = node.getAttribute('type')!;
          if (node.getAttribute('role')) semanticNode.attributes!['role'] = node.getAttribute('role')!;
          if (tagName === 'img' && node.getAttribute('alt')) semanticNode.attributes!['alt'] = node.getAttribute('alt')!;
          if (tagName === 'script' && node.getAttribute('src')) semanticNode.attributes!['src'] = node.getAttribute('src')!;
          
          if (tagName === 'input' || tagName === 'textarea') {
            semanticNode.value = (node as HTMLInputElement).value;
          }

          if (securityFlags.length > 0) semanticNode.securityFlags = securityFlags;
          if (Object.keys(performanceMetrics).length > 0) semanticNode.performanceMetrics = performanceMetrics;

          if (children.length > 0) {
            semanticNode.children = children;
          }
          return [semanticNode];
        }

        return children;
      }

      const bodySemanticNodes = processNode(document.body);
      return {
        id: 'root',
        type: 'root',
        children: bodySemanticNodes
      } as SemanticNode;
    }, lens);

    if (!intent) {
      return { tree: rawTree, tokensSaved: 0 };
    }

    const keywords = intent.toLowerCase().split(' ').filter(w => w.length > 2);
    
    // Scorer function
    function scoreNode(node: SemanticNode): number {
      let score = 0;
      const textToSearch = [
        node.text || '',
        node.attributes?.['aria-label'] || '',
        node.attributes?.['placeholder'] || '',
        node.attributes?.['href'] || '',
        node.attributes?.['alt'] || '',
        ...(node.securityFlags || []),
      ].join(' ').toLowerCase();

      for (const kw of keywords) {
        if (textToSearch.includes(kw)) {
          score += 10;
        }
      }

      let childScore = 0;
      if (node.children) {
        for (const child of node.children) {
          childScore += scoreNode(child);
        }
      }

      node.score = score + childScore;
      return node.score;
    }

    scoreNode(rawTree);

    // Prune tree
    function pruneNode(node: SemanticNode): SemanticNode | null {
      if (node.score === 0 && node.type !== 'root') {
        // Aggressively prune nodes with 0 score to save tokens
        return null;
      }

      if (node.children) {
        node.children = node.children.map(pruneNode).filter((n): n is SemanticNode => n !== null);
      }
      
      delete node.score;
      return node;
    }

    const rawStr = JSON.stringify(rawTree);
    const optimizedTree = pruneNode(rawTree) || { id: 'root', type: 'root', children: [] };
    const optimizedStr = JSON.stringify(optimizedTree);
    
    const tokensSaved = Math.max(0, Math.floor((rawStr.length - optimizedStr.length) / 4));

    return { tree: optimizedTree, tokensSaved };
  }
}
