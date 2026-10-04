import { useMemo } from 'react';
import { html } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib/types';
import type { DiffFileResponse } from '@orca-git-graph/core';
import { useAsync } from '../hooks.js';
import { t } from '../i18n.js';

export interface DiffViewProps {
  /** `null` = nothing selected */
  load: (() => Promise<DiffFileResponse>) | null;
  /** Changing any dep reloads the diff */
  deps: readonly unknown[];
  layout: 'side-by-side' | 'line-by-line';
  theme: 'system' | 'light' | 'dark';
}

export function DiffView({ load, deps, layout, theme }: DiffViewProps) {
  const state = useAsync(load, deps);
  const diff = state.data;
  const rendered = useMemo(() => {
    if (!diff || diff.truncated || diff.diff.trim() === '') return '';
    // diff2html escapes file content itself; the string only contains markup it generated.
    return html(diff.diff, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: layout,
      renderNothingWhenEmpty: false,
      colorScheme: theme === 'dark' ? ColorSchemeType.DARK : theme === 'light' ? ColorSchemeType.LIGHT : ColorSchemeType.AUTO,
    });
  }, [diff, layout, theme]);

  if (!load) return <div className="pane-empty">{t.selectFile}</div>;
  if (state.error) return <div className="pane-empty error">{state.error.message}</div>;
  if (!diff) return <div className="pane-empty">{t.loading}</div>;
  if (diff.truncated) return <div className="pane-empty">{t.diffTruncated}</div>;
  if (diff.diff.trim() === '') return <div className="pane-empty">{t.noChanges}</div>;
  if (/^Binary files .* differ$/m.test(diff.diff) && !/^@@/m.test(diff.diff)) return <div className="pane-empty">{t.diffBinary}</div>;
  return <div className="diff-view" dangerouslySetInnerHTML={{ __html: rendered }} />;
}
