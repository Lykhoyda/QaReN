/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CommandJournalTest {
    @Test
    fun recordsAndLooksUpOutcomes() {
        val j = CommandJournal()
        j.record("c-1", "tap", true, """{"ok":true,"data":{"tapped":true}}""")
        j.record("c-2", "tap", false, """{"ok":false,"error":{"message":"boom"}}""")
        assertEquals("completed", j.lookup("c-1")?.state)
        assertEquals("""{"ok":true,"data":{"tapped":true}}""", j.lookup("c-1")?.body)
        assertEquals("failed", j.lookup("c-2")?.state)
        assertNull(j.lookup("c-404"))
    }

    @Test
    fun skipsBlankIdsAndStatusCommands() {
        val j = CommandJournal()
        j.record(null, "tap", true, "{}")
        j.record("", "tap", true, "{}")
        j.record("c-s", "status", true, "{}")
        assertNull(j.lookup(""))
        assertNull(j.lookup("c-s"))
    }

    @Test
    fun retainsStateButNotBodyForSnapshotScreenshotAndOversized() {
        val j = CommandJournal(capacity = 32, maxRetainedBytes = 16)
        j.record("c-snap", "snapshot", true, """{"ok":true}""")
        j.record("c-shot", "screenshot", true, """{"ok":true}""")
        j.record("c-big", "tap", true, "x".repeat(64))
        assertEquals("completed", j.lookup("c-snap")?.state)
        assertNull(j.lookup("c-snap")?.body)
        assertNull(j.lookup("c-shot")?.body)
        assertEquals("completed", j.lookup("c-big")?.state)
        assertNull(j.lookup("c-big")?.body)
    }

    @Test
    fun capCountsUtf8BytesNotUtf16CodeUnits() {
        val j = CommandJournal(capacity = 32, maxRetainedBytes = 16)
        val multibyte = "€".repeat(6) // 6 UTF-16 code units, 18 UTF-8 bytes
        j.record("c-mb", "tap", true, multibyte)
        assertEquals("completed", j.lookup("c-mb")?.state)
        assertNull(j.lookup("c-mb")?.body)
    }

    @Test
    fun evictsOldestBeyondCapacity() {
        val j = CommandJournal(capacity = 3)
        for (i in 1..5) j.record("c-$i", "tap", true, "{}")
        assertNull(j.lookup("c-1"))
        assertNull(j.lookup("c-2"))
        assertEquals("completed", j.lookup("c-3")?.state)
        assertEquals("completed", j.lookup("c-5")?.state)
    }
}
