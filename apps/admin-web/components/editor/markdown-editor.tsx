'use client';

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { htmlToMarkdown } from '../../lib/paste-as-markdown';

/**
 * The CodeMirror 6 host.
 *
 * Mounted client-side only — CodeMirror touches `document` at construction, so
 * the route loads this through `next/dynamic` with `ssr: false`.
 *
 * A rich-text paste is converted to markdown here rather than inserted as HTML,
 * which the parser would reject (§5.3).
 */

export interface EditorHandle {
  /** Replaces the selection with `text`, then places the cursor after it. */
  insert: (text: string) => void;
  /** Wraps the selection, or inserts the pair and places the cursor between. */
  wrap: (before: string, after: string) => void;
  /** Prefixes each selected line, for headings, quotes and list items. */
  prefixLines: (prefix: string) => void;
  focus: () => void;
}

const readOnlyExtensions = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  readOnly,
  handleRef,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  readOnly: boolean;
  handleRef?: Ref<EditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef<Compartment | null>(null);
  readOnlyCompartment.current ??= new Compartment();

  // Refs so rebuilding the view is never triggered by a new closure identity.
  const callbacks = useRef({ onChange, onBlur });
  callbacks.current = { onChange, onBlur };
  const initial = useRef({ value, readOnly });

  useEffect(() => {
    if (!host.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      readOnlyCompartment.current!.of(readOnlyExtensions(initial.current.readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        blur: () => {
          callbacks.current.onBlur();
          return false;
        },
        paste: (event, target) => {
          const html = event.clipboardData?.getData('text/html');
          if (!html) return false;

          const converted = htmlToMarkdown(html);
          if (!converted) return false;

          event.preventDefault();
          target.dispatch(target.state.replaceSelection(converted));
          return true;
        },
      }),
    ];

    const instance = new EditorView({
      state: EditorState.create({ doc: initial.current.value, extensions }),
      parent: host.current,
    });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
    };
  }, []);

  /** External changes — the initial load, or a conflict reload — are pushed in. */
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

    const current = instance.state.doc.toString();
    if (current === value) return;

    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const instance = view.current;
    const compartment = readOnlyCompartment.current;
    if (!instance || !compartment) return;

    instance.dispatch({ effects: compartment.reconfigure(readOnlyExtensions(readOnly)) });
  }, [readOnly]);

  useImperativeHandle(
    handleRef,
    (): EditorHandle => ({
      insert: (text) => {
        const instance = view.current;
        if (!instance) return;
        instance.dispatch(instance.state.replaceSelection(text));
        instance.focus();
      },
      wrap: (before, after) => {
        const instance = view.current;
        if (!instance) return;
        const { from, to } = instance.state.selection.main;
        const selected = instance.state.sliceDoc(from, to);
        instance.dispatch({
          changes: { from, to, insert: `${before}${selected}${after}` },
          selection: { anchor: from + before.length + selected.length },
        });
        instance.focus();
      },
      prefixLines: (prefix) => {
        const instance = view.current;
        if (!instance) return;
        const { from, to } = instance.state.selection.main;
        const firstLine = instance.state.doc.lineAt(from);
        const lastLine = instance.state.doc.lineAt(to);

        const changes: Array<{ from: number; insert: string }> = [];
        for (let number = firstLine.number; number <= lastLine.number; number += 1) {
          changes.push({ from: instance.state.doc.line(number).from, insert: prefix });
        }
        instance.dispatch({ changes });
        instance.focus();
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return (
    <div
      ref={host}
      data-testid="markdown-source"
      className="h-full min-h-[32rem] overflow-auto border border-slate-200 text-sm"
    />
  );
}
