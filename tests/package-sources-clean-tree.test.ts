import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

describe('source package clean-tree regression (P1-quality-source-package-clean-tree-repair)', () => {
  it('keeps the clean-tree gate and surfaces the exact porcelain', () => {
    const script = readFileSync(resolve(root, 'scripts/package-sources.mjs'), 'utf8');
    expect(script).toContain("git', ['status', '--porcelain']");
    expect(script).toContain("Source package requires a clean git tree in CI");
    // The error must include the porcelain so CI logs show which file is dirty.
    expect(script).toContain('porcelain:');
    // Must not waive the check or hide arbitrary dirty.
    expect(script).not.toContain('status --porcelain --ignored');
    expect(script).not.toMatch(/if \(status\) {\s*\/\/ ignore/);
  });

  it('preserves zip:all ordering and does not remove zip:sources', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const zipAll: string = pkg.scripts?.['zip:all'] ?? '';
    expect(zipAll).toContain('zip:chrome');
    expect(zipAll).toContain('zip:edge');
    expect(zipAll).toContain('zip:firefox');
    expect(zipAll).toContain('zip:sources');
    // The source package must still be the last step so git archive sees a clean tree.
    const last = zipAll.split('&&').at(-1)?.trim() ?? '';
    expect(last).toBe('npm run zip:sources');
  });

  it('normalizes the P1 adr file to LF per .gitattributes', () => {
    const gitattributes = readFileSync(resolve(root, '.gitattributes'), 'utf8');
    expect(gitattributes).toContain('*.md        text eol=lf');
    const adr = readFileSync(resolve(root, 'docs/architecture/adr-001-local-runtime-language.md'), 'utf8');
    // No CRLF in the stored file.
    expect(adr).not.toContain('\r\n');
    // Ends with a single LF, not double.
    expect(adr.endsWith('\n')).toBe(true);
    expect(adr.endsWith('\n\n')).toBe(false);
  });
});