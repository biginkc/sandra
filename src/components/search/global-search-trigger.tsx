"use client";

import { SearchIcon } from "lucide-react";
import { useGlobalSearchContext } from "./global-search-provider";
import styles from "./global-search.module.css";

export function GlobalSearchTrigger() {
  const { triggerRef, changeOpen, modKey } = useGlobalSearchContext();
  return <button ref={triggerRef} type="button" aria-label="Search" onClick={() => changeOpen(true)} className={styles.trigger}>
    <span className={styles.pill}><SearchIcon size={16} aria-hidden="true" />
      <span className={styles.triggerLabel}>Search properties, owners, texts</span>
      <span className={styles.modKey}>{modKey} K</span>
    </span>
  </button>;
}
