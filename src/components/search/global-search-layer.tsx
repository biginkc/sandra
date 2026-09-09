"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { HomeIcon, UserIcon, MessageSquareIcon, SearchIcon, XIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useGlobalSearchContext } from "./global-search-provider";
import type { SearchResult } from "./use-global-search";
import styles from "./global-search.module.css";

const kinds = [
  { type: "property", label: "Properties", Icon: HomeIcon },
  { type: "owner", label: "Owners", Icon: UserIcon },
  { type: "thread", label: "Messages", Icon: MessageSquareIcon },
] as const;
const hints = ["816 555 1234", "907 N Jerry", "Raymore", "64083", "marisol.h@gmail.com", '"still own"'];

export function GlobalSearchLayer() {
  const { open, changeOpen, triggerRef, search } = useGlobalSearchContext();
  const { query, results, status, skeleton, setQuery } = search;
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const id = useId();
  const groups = useMemo(() => kinds.map(kind => ({ ...kind, rows: results.filter(row => row.type === kind.type) })).filter(group => group.rows.length), [results]);
  const rows = useMemo(() => groups.flatMap(group => group.rows), [groups]);
  const [selection, setSelection] = useState({ results, key: "" });
  // Reset selection with a newly committed result array, never with a keystroke.
  const selected = selection.results === results ? (selection.key || rows[0]?.key) : rows[0]?.key;
  const optionId = (key: string) => `${id}-option-${encodeURIComponent(key)}`;
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = selected ? rowRefs.current.get(selected) : undefined;
    if (!open || !list || !row) return;
    const container = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const top = container.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (rect.top < top) list.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
  }, [open, selected, results]);
  const activate = (row: SearchResult) => {
    changeOpen(false);
    router.push(row.href);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!rows.length) return;
    const index = Math.max(0, rows.findIndex(row => row.key === selected));
    if (event.key === "Enter") {
      event.preventDefault();
      activate(rows[index]);
      return;
    }
    let next = index;
    const down = event.key === "ArrowDown" || (event.ctrlKey && ["n", "j"].includes(event.key.toLowerCase()));
    const up = event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p");
    if (event.key === "Home" || (event.metaKey && up)) next = 0;
    else if (event.key === "End" || (event.metaKey && down)) next = rows.length - 1;
    else if (down || up) {
      const direction = down ? 1 : -1;
      if (event.altKey) {
        const groupIndex = groups.findIndex(group => group.type === rows[index].type);
        const group = groups[groupIndex + direction];
        next = group ? rows.indexOf(group.rows[0]) : index + direction;
      } else next = index + direction;
    } else return;
    event.preventDefault();
    setSelection({ results, key: rows[Math.max(0, Math.min(rows.length - 1, next))].key });
  };
  const loading = status === "loading";
  const count = `${rows.length} ${rows.length === 1 ? "result" : "results"}`;
  return <Dialog.Root open={open} onOpenChange={changeOpen} modal>
    <Dialog.Portal>
      <Dialog.Backdrop className={styles.backdrop} />
      <Dialog.Popup className={styles.layer} initialFocus={inputRef} finalFocus={triggerRef} aria-label="Search">
        <Dialog.Title className={styles.srOnly}>Search</Dialog.Title>
        <div className={styles.topBar}><div className={styles.topInner}>
          <div className={styles.inputBox} data-unavailable={status === "unavailable" || undefined}>
            <span className={styles.leading} aria-hidden="true">{loading ? <span className={styles.spinner} data-testid="search-spinner" /> : <SearchIcon size={20} />}</span>
            <input ref={inputRef} className={styles.input} role="combobox" aria-label="Search" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={selected ? optionId(selected) : undefined}
              value={query} maxLength={100} autoComplete="off" autoCorrect="off" spellCheck={false}
              placeholder="Address, owner, phone, APN, or a word from a text" onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} />
            {query !== "" && <button type="button" aria-label="Clear" className={styles.clear} onClick={() => { setQuery(""); inputRef.current?.focus({ preventScroll: true }); }}><XIcon size={14} aria-hidden="true" /></button>}
            {loading && <div className={styles.progress} data-testid="search-progress" aria-hidden="true"><span /></div>}
          </div>
          <Dialog.Close className={styles.close} aria-label="Close search"><span className={styles.desktop}>Close</span><kbd>esc</kbd></Dialog.Close>
        </div></div>
        <div className={styles.body} ref={listRef}>
          <div className={styles.column}>
            {status === "idle" && <div className={styles.idle}><div>Type at least 3 characters</div><div className={styles.hints}>{hints.map(hint => <span key={hint}>{hint}</span>)}</div></div>}
            {status === "empty" && <div className={styles.empty}><div>No matches for “{query.trim()}”</div><p>Try fewer words, a house number, or the last 4 digits of a phone.</p></div>}
            {status === "unavailable" && <div role="alert" className={styles.unavailable}><TriangleAlertIcon size={20} aria-hidden="true" /><div><strong>Search unavailable</strong><p>Keep typing — it retries on your next keystroke.</p></div></div>}
            {loading && skeleton && rows.length === 0 && <div className={styles.skeleton} data-testid="search-skeleton" aria-hidden="true"><div className={styles.skeletonLabel} />{[[42, 28], [38, 26], [46, 30]].map(([primary, secondary]) => <div className={styles.skeletonRow} key={primary}><div style={{ width: `${primary}%` }} /><div style={{ width: `${secondary}%` }} /></div>)}</div>}
            <div id={`${id}-list`} role="listbox" aria-label="Search results" className={styles.results} data-retained={loading && rows.length > 0 || undefined}>
              {groups.map(({ type, label, Icon, rows: items }) => <div role="group" aria-labelledby={`${id}-${type}`} key={type} className={styles.group}>
                <div className={styles.heading}><Icon size={13} aria-hidden="true" /><span id={`${id}-${type}`}>{label}</span><span className={styles.count}>{items.length}</span></div>
                {items.map(row => <div key={row.key} id={optionId(row.key)} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }} role="option" aria-selected={selected === row.key} className={styles.row}
                  onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelection({ results, key: row.key })} onClick={() => activate(row)}>
                  <div className={styles.text}><div className={styles.primary}>{row.title}</div>{row.subtitle && <div className={styles.secondary} data-message={type === "thread" || undefined}>{row.subtitle}</div>}</div>
                  {(row.matchedField === "phone" || row.matchedField === "email") && <span className={styles.badge}>{row.matchedField}</span>}
                  {selected === row.key && <span className={styles.open}>Open <kbd>↵</kbd></span>}
                </div>)}
              </div>)}
            </div>
          </div>
        </div>
        <div role="status" className={styles.srOnly}>{loading ? (rows.length ? "Searching… Previous results remain available." : "Searching…") : status === "results" ? count : status === "empty" ? "No matches" : ""}</div>
        <footer className={styles.footer}><div className={styles.footerInner}><span className={styles.keys}><span><kbd>↑↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></span><span className={styles.note}>{loading ? "Searching…" : rows.length ? count : "Your organisation only"}</span></div></footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
