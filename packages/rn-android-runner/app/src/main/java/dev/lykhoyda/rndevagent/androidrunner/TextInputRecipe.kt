package dev.lykhoyda.rndevagent.androidrunner

// Story 10 (#391): text-input recipe helpers for the `type` command. RN
// TextInput is EditText-backed, so the bound node accepts ACTION_SET_TEXT
// (performed on its AccessibilityNodeInfo, never through UiObject2.setText,
// which logs the value) — atomic, full-Unicode, fires RN's onChangeText. This
// object holds the pure logic around that primary path: classifying the
// read-back outcome and mapping ASCII characters to keyevents for the
// fallback tier (Maestro's 75 ms pacing). Kept free of android.* imports so
// the JVM unit suite covers it directly (like KeyboardGuard).
object TextInputRecipe {
    const val KEYEVENT_PACING_MS = 75L

    private val INPUT_TYPE_PATTERN = Regex(".+\\.(\\w*EditText|\\w*AutoCompleteTextView)$")

    enum class SetTextOutcome { ACCEPTED, TRANSFORMED, REJECTED, UNVERIFIED }

    data class VerifyObservation(
        val raw: String?,
        val hint: String?,
        val hintKnown: Boolean,
        val verdict: String,
    )

    // Read-back classification after a set attempt:
    //   ACCEPTED    — field now holds exactly the requested text.
    //   TRANSFORMED — field changed to something else (input mask, uppercase
    //                 transform, formatter). The set landed; the component
    //                 reshaped it. Retyping would not converge.
    //   REJECTED    — field did not change at all: the set was ignored
    //                 (e.g. a controlled component re-rendering from state).
    //   UNVERIFIED  — no read-back available (focused node gone after a
    //                 re-render): the set may well have landed, so neither a
    //                 success proof nor a rejection — callers must not retype
    //                 (double-apply risk) nor claim a verified outcome.
    fun classifySetText(requested: String, before: String?, after: String?): SetTextOutcome {
        if (after == null) return SetTextOutcome.UNVERIFIED
        if (after == requested) return SetTextOutcome.ACCEPTED
        if (after != before.orEmpty()) return SetTextOutcome.TRANSFORMED
        return SetTextOutcome.REJECTED
    }

    // Codex P2 round-2 (#564): acceptance rule for the keyevent fallback tier.
    // Unlike the setText primary, a TRANSFORMED read-back here is only
    // trustworthy when the field started empty — on a non-empty field the
    // "transform" can be an under-deleted `old + text` remnant, which must
    // descend to the Maestro tier (eraseText + inputText) instead of passing
    // as a formatter reshape. UNVERIFIED stays usable: no read-back proof
    // either way, and retyping risks double-apply.
    fun keyEventOutcomeUsable(outcome: SetTextOutcome, beforeWasEmpty: Boolean): Boolean =
        when (outcome) {
            SetTextOutcome.ACCEPTED, SetTextOutcome.UNVERIFIED -> true
            SetTextOutcome.TRANSFORMED -> beforeWasEmpty
            SetTextOutcome.REJECTED -> false
        }

    // A read of the bound input's accessibility node. Android reports null text
    // for an empty field that shows no hint, so a fresh read of a field known
    // not to show one is "". Stale nodes are always unreadable; fresh nodes
    // with unknown hint state (API < 26) or a showing hint keep their raw text,
    // so null stays unreadable there.
    fun readableText(fresh: Boolean, text: String?, showingHint: Boolean?): String? {
        if (!fresh) return null
        return if (showingHint == false) text.orEmpty() else text
    }

    fun classifyVerify(
        expected: String,
        raw: String?,
        hint: String?,
        hintKnown: Boolean,
        secure: Boolean,
    ): String {
        if (raw == null) return "unreadable"
        val placeholderEqual = !hint.isNullOrEmpty() && raw == hint
        if (secure) {
            if (expected.isEmpty()) {
                if (raw.isEmpty()) return "exact"
                return if (!hintKnown || placeholderEqual) "ambiguous" else "mismatch"
            }
            // An empty or hint read, or a mask of another length, proves the value did not land.
            if (raw.isEmpty() || placeholderEqual) return "mismatch"
            val maskedLength = raw.all { it == '\u2022' }
            return if (maskedLength && raw.length != expected.length &&
                raw.length != expected.codePointCount(0, expected.length)) "mismatch" else "secure-masked"
        }
        if (expected.isEmpty()) {
            if (raw.isEmpty()) return "exact"
            return if (!hintKnown || placeholderEqual) "ambiguous" else "mismatch"
        }
        // A placeholder read cannot prove a typed value, even one equal to the placeholder.
        if (raw == expected) return if (placeholderEqual) "mismatch" else if (!hintKnown) "ambiguous" else "exact"
        return "mismatch"
    }

    fun verifyObservation(
        expected: String,
        raw: String?,
        hint: String?,
        hintKnown: Boolean,
        secure: Boolean,
    ): VerifyObservation = VerifyObservation(
        raw,
        hint,
        hintKnown,
        classifyVerify(expected, raw, hint, hintKnown, secure),
    )

    fun recordedDescriptorAgrees(
        recordedGeneration: Int?,
        recordedNodeIndex: Int?,
        recordedLiveType: String?,
        recordedLiveIdentifier: String?,
        requestedGeneration: Int?,
        requestedNodeIndex: Int?,
        requestedElementType: String?,
        requestedIdentifier: String?,
    ): Boolean {
        if (recordedGeneration == null || recordedNodeIndex == null || recordedLiveType == null) {
            return false
        }
        if (!INPUT_TYPE_PATTERN.matches(recordedLiveType)) return false
        return recordedGeneration == requestedGeneration &&
            recordedNodeIndex == requestedNodeIndex &&
            recordedLiveType == requestedElementType &&
            recordedLiveIdentifier == requestedIdentifier
    }

    data class TargetFrame(val left: Int, val top: Int, val right: Int, val bottom: Int)

    data class TargetIdentity(
        val type: String,
        val identifier: String?,
        val frame: TargetFrame,
    )

    sealed interface TargetResolution {
        data class Unique(val index: Int) : TargetResolution
        data object Ambiguous : TargetResolution
        data object Absent : TargetResolution
    }

    private fun framesMatch(a: TargetFrame, b: TargetFrame, tolerance: Int = 8): Boolean =
        kotlin.math.abs((a.left + a.right) - (b.left + b.right)) <= tolerance * 2 &&
            kotlin.math.abs((a.top + a.bottom) - (b.top + b.bottom)) <= tolerance * 2 &&
            kotlin.math.abs((a.right - a.left) - (b.right - b.left)) <= tolerance &&
            kotlin.math.abs((a.bottom - a.top) - (b.bottom - b.top)) <= tolerance

    fun resolveIdentifier(
        candidates: List<TargetIdentity>,
        expectedType: String?,
        identifier: String,
        expectedFrame: TargetFrame?,
        requireFrame: Boolean,
    ): TargetResolution {
        val matches = candidates.withIndex().filter { it.value.identifier == identifier }
        if (matches.size > 1) return TargetResolution.Ambiguous
        val match = matches.firstOrNull() ?: return TargetResolution.Absent
        if (expectedType != null && match.value.type != expectedType) return TargetResolution.Absent
        if (requireFrame && (expectedFrame == null || !framesMatch(match.value.frame, expectedFrame))) {
            return TargetResolution.Absent
        }
        return TargetResolution.Unique(match.index)
    }

    data class KeyStroke(val keyCode: Int, val shift: Boolean)

    // android.view.KeyEvent constants, inlined as plain Ints so this object
    // stays JVM-pure. Values are stable public API.
    private const val KEYCODE_0 = 7
    private const val KEYCODE_A = 29
    private const val KEYCODE_COMMA = 55
    private const val KEYCODE_PERIOD = 56
    private const val KEYCODE_TAB = 61
    private const val KEYCODE_SPACE = 62
    private const val KEYCODE_ENTER = 66
    private const val KEYCODE_GRAVE = 68
    private const val KEYCODE_MINUS = 69
    private const val KEYCODE_EQUALS = 70
    private const val KEYCODE_LEFT_BRACKET = 71
    private const val KEYCODE_RIGHT_BRACKET = 72
    private const val KEYCODE_BACKSLASH = 73
    private const val KEYCODE_SEMICOLON = 74
    private const val KEYCODE_APOSTROPHE = 75
    private const val KEYCODE_SLASH = 76
    private const val KEYCODE_AT = 77
    private const val KEYCODE_PLUS = 81

    // Shifted pairs on the US virtual keycharmap (emulator default).
    private val SHIFTED: Map<Char, KeyStroke> = mapOf(
        '!' to KeyStroke(KEYCODE_0 + 1, shift = true),
        '#' to KeyStroke(KEYCODE_0 + 3, shift = true),
        '$' to KeyStroke(KEYCODE_0 + 4, shift = true),
        '%' to KeyStroke(KEYCODE_0 + 5, shift = true),
        '^' to KeyStroke(KEYCODE_0 + 6, shift = true),
        '&' to KeyStroke(KEYCODE_0 + 7, shift = true),
        '*' to KeyStroke(KEYCODE_0 + 8, shift = true),
        '(' to KeyStroke(KEYCODE_0 + 9, shift = true),
        ')' to KeyStroke(KEYCODE_0, shift = true),
        '_' to KeyStroke(KEYCODE_MINUS, shift = true),
        ':' to KeyStroke(KEYCODE_SEMICOLON, shift = true),
        '"' to KeyStroke(KEYCODE_APOSTROPHE, shift = true),
        '<' to KeyStroke(KEYCODE_COMMA, shift = true),
        '>' to KeyStroke(KEYCODE_PERIOD, shift = true),
        '?' to KeyStroke(KEYCODE_SLASH, shift = true),
        '{' to KeyStroke(KEYCODE_LEFT_BRACKET, shift = true),
        '}' to KeyStroke(KEYCODE_RIGHT_BRACKET, shift = true),
        '|' to KeyStroke(KEYCODE_BACKSLASH, shift = true),
        '~' to KeyStroke(KEYCODE_GRAVE, shift = true),
    )

    private val UNSHIFTED: Map<Char, KeyStroke> = mapOf(
        ' ' to KeyStroke(KEYCODE_SPACE, shift = false),
        '\t' to KeyStroke(KEYCODE_TAB, shift = false),
        '\n' to KeyStroke(KEYCODE_ENTER, shift = false),
        ',' to KeyStroke(KEYCODE_COMMA, shift = false),
        '.' to KeyStroke(KEYCODE_PERIOD, shift = false),
        '-' to KeyStroke(KEYCODE_MINUS, shift = false),
        '=' to KeyStroke(KEYCODE_EQUALS, shift = false),
        '[' to KeyStroke(KEYCODE_LEFT_BRACKET, shift = false),
        ']' to KeyStroke(KEYCODE_RIGHT_BRACKET, shift = false),
        '\\' to KeyStroke(KEYCODE_BACKSLASH, shift = false),
        ';' to KeyStroke(KEYCODE_SEMICOLON, shift = false),
        '\'' to KeyStroke(KEYCODE_APOSTROPHE, shift = false),
        '/' to KeyStroke(KEYCODE_SLASH, shift = false),
        '`' to KeyStroke(KEYCODE_GRAVE, shift = false),
        '@' to KeyStroke(KEYCODE_AT, shift = false),
        '+' to KeyStroke(KEYCODE_PLUS, shift = false),
    )

    fun keyStrokeFor(c: Char): KeyStroke? = when (c) {
        in 'a'..'z' -> KeyStroke(KEYCODE_A + (c - 'a'), shift = false)
        in 'A'..'Z' -> KeyStroke(KEYCODE_A + (c - 'A'), shift = true)
        in '0'..'9' -> KeyStroke(KEYCODE_0 + (c - '0'), shift = false)
        else -> UNSHIFTED[c] ?: SHIFTED[c]
    }

    // Emoji, IME-composed, and non-US-keymap text has no keyevent
    // representation — the fallback tier only applies when every character maps.
    fun isKeyEventTypable(text: String): Boolean =
        text.isNotEmpty() && text.all { keyStrokeFor(it) != null }

    // Codex P2 round-3 (#564): the bridge aborts `type` commands after 35 s,
    // and this tier paces at 75 ms/char — past ~200 characters the runner
    // would time out mid-fallback instead of returning SET_TEXT_REJECTED for
    // the Maestro tier to handle.
    const val KEYEVENT_FALLBACK_MAX_CHARS = 200

    // Viability of the whole keyevent fallback tier: empty text clears via
    // the delete pass; non-empty text must both map to keyevents and fit the
    // paced-typing time budget.
    fun keyEventFallbackViable(text: String): Boolean =
        text.isEmpty() || (isKeyEventTypable(text) && text.length <= KEYEVENT_FALLBACK_MAX_CHARS)
}
