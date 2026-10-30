package dev.lykhoyda.rndevagent.androidrunner

object KeyboardGuard {
    class DismissRefused(val code: String, val backAttempted: Boolean) : IllegalStateException(code)

    data class DismissResult(val wasVisible: Boolean, val dismissed: Boolean)

    fun inputShown(dump: String): Boolean? {
        val values = Regex("""(?<!\S)mInputShown=(\S+)""")
            .findAll(dump).map { it.groupValues[1] }.toList()
        return values.singleOrNull()?.toBooleanStrictOrNull()
    }

    fun screenContent(nodes: List<QaHierarchy.QaNode>): List<QaHierarchy.QaNode> =
        nodes.filter { it.type != "Keyboard" }.map {
            it.copy(rect = QaHierarchy.Bounds(0, 0, 0, 0), hittable = false, visibleToUser = false, source = null)
        }

    fun dismiss(
        shown: () -> Boolean?,
        sameScreen: () -> Boolean,
        pressBack: () -> Boolean,
        now: () -> Long,
        sleep: (Long) -> Unit,
    ): DismissResult {
        fun visible(attempted: Boolean): Boolean = runCatching(shown).getOrNull()
            ?: throw DismissRefused("KEYBOARD_VISIBILITY_UNKNOWN", attempted)
        fun unchanged(attempted: Boolean) {
            if (!runCatching(sameScreen).getOrDefault(false)) {
                throw DismissRefused("ACTION_CONTEXT_CHANGED", attempted)
            }
        }
        if (!visible(false)) return DismissResult(false, false)
        unchanged(false)
        // Re-read after capturing the screen so a keyboard already closing never admits BACK.
        if (!visible(false)) return DismissResult(false, false)
        if (!runCatching(pressBack).getOrDefault(false)) {
            throw DismissRefused("KEYBOARD_DISMISS_FAILED", true)
        }
        val deadline = now() + 2_000L
        while (true) {
            val stillShown = visible(true)
            unchanged(true)
            if (!stillShown) return DismissResult(true, true)
            if (now() >= deadline) throw DismissRefused("KEYBOARD_DISMISS_FAILED", true)
            sleep(50L)
        }
    }

    fun shouldDismiss(imeLeft: Int, imeTop: Int, imeRight: Int, imeBottom: Int, tapX: Int, tapY: Int, minHeightPx: Int): Boolean {
        val width = imeRight - imeLeft
        val height = imeBottom - imeTop
        if (width <= 0 || height < minHeightPx) return false
        return tapX in imeLeft until imeRight && tapY in imeTop until imeBottom
    }
}
