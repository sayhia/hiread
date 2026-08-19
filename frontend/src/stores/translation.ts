// Background chapter-translation jobs (Pinia). A translation runs to completion
// independently of which chapter is on screen, so several can be in flight at
// once — turning the page mid-translation does not throw the work away.
// Progress arrives per batch. Jobs are keyed "<bookId>:<chapterIndex>".

import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "../api";
import { reportError } from "./toasts";

export type JobStatus = "translating" | "done" | "error";

export interface TranslationJob {
  status: JobStatus;
  done: number;
  total: number;
  html: string;
  /** Translated title (arrives on the start event; empty until then). */
  title: string;
  lang: string;
  engine: string;
}

/** The store key for one chapter of one book. */
export function jobKey(bookId: number, chapterIndex: number): string {
  return `${bookId}:${chapterIndex}`;
}

export const useTranslationJobs = defineStore("translation", () => {
  const jobs = ref<Record<string, TranslationJob>>({});

  function patch(key: string, fn: (j: TranslationJob) => TranslationJob) {
    const cur = jobs.value[key];
    if (!cur) return;
    jobs.value = { ...jobs.value, [key]: fn(cur) };
  }

  function translate(bookId: number, chapterIndex: number, lang: string, engine: string) {
    const key = jobKey(bookId, chapterIndex);
    const cur = jobs.value[key];
    if (cur?.status === "translating" && cur.lang === lang && cur.engine === engine) return;
    jobs.value = {
      ...jobs.value,
      [key]: { status: "translating", done: 0, total: 0, html: "", title: "", lang, engine },
    };

    // Guard every mutation against this run's identity: a newer translation of
    // the same chapter (the user switched target language/engine) replaces the
    // job, and this run's late batch events / settle must not clobber the new one.
    const owns = () => {
      const j = jobs.value[key];
      return j != null && j.lang === lang && j.engine === engine;
    };

    api
      .aiTranslate(bookId, chapterIndex, lang, engine, (e) => {
        if (!owns()) return;
        if (e.type === "start") {
          patch(key, (j) => ({ ...j, total: e.data.total, title: e.data.title || j.title }));
        } else if (e.type === "batch") {
          // A batch arrives in pieces now — whole blocks as the model writes
          // them, then a final event that carries the count and no text. Both
          // fields are optional on the wire (Go omits their zero values), so
          // neither may overwrite what is already here with undefined.
          patch(key, (j) => ({
            ...j,
            done: e.data.done ?? j.done,
            html: j.html + (e.data.html ?? ""),
          }));
        } else if (e.type === "done") {
          patch(key, (j) => ({ ...j, html: e.data.html, title: e.data.title || j.title, status: "done" }));
        }
      })
      .then(() => {
        if (owns()) patch(key, (j) => (j.status === "translating" ? { ...j, status: "done" } : j));
      })
      .catch((err) => {
        if (!owns()) return;
        patch(key, (j) => ({ ...j, status: "error" }));
        reportError(err);
      });
  }

  function clear(key: string) {
    if (!(key in jobs.value)) return;
    const rest = { ...jobs.value };
    delete rest[key];
    jobs.value = rest;
  }

  return { jobs, translate, clear };
});
