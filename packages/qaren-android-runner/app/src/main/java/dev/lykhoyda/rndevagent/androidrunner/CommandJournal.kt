/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

// Story 14 (#407): bounded journal of recent /command outcomes so the client
// can distinguish "never executed" from "executed, response lost" after an
// ambiguous transport failure. NanoHTTPD serves connections on worker threads,
// so all access is synchronized. Heavy payloads (snapshot nodes, screenshot
// base64) keep only their state — both verbs are read-only, so the client may
// safely re-send instead.
class CommandJournal(
    private val capacity: Int = 32,
    private val maxRetainedBytes: Int = 8192,
) {
    data class Entry(val state: String, val body: String?)

    private val lock = Any()
    private val entries = object : LinkedHashMap<String, Entry>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>): Boolean =
            size > capacity
    }

    fun record(commandId: String?, command: String?, ok: Boolean, body: String) {
        if (commandId.isNullOrBlank() || command == "status") return
        // UTF-8 byte count, not String.length (UTF-16 code units) — keeps the
        // retention cap identical to the Swift journal's Data.count.
        val retain = command != "snapshot" && command != "screenshot" &&
            body.toByteArray(Charsets.UTF_8).size <= maxRetainedBytes
        synchronized(lock) {
            entries[commandId] = Entry(if (ok) "completed" else "failed", if (retain) body else null)
        }
    }

    fun lookup(commandId: String): Entry? = synchronized(lock) { entries[commandId] }
}
