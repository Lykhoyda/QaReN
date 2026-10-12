package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.TextInputRecipe.SetTextOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Story 10 (#391): pure-logic coverage for the ACTION_SET_TEXT read-back
// classifier and the keyevent fallback mapping.
class TextInputRecipeTest {

    @Test
    fun setTextExactReadBackIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("hello", before = "", after = "hello"),
        )
    }

    @Test
    fun setTextEmojiReadBackIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("héllo 👋🏽 世界", before = "", after = "héllo 👋🏽 世界"),
        )
    }

    @Test
    fun setTextClearingAFieldIsAccepted() {
        assertEquals(
            SetTextOutcome.ACCEPTED,
            TextInputRecipe.classifySetText("", before = "old", after = ""),
        )
    }

    @Test
    fun setTextMaskedValueIsTransformed() {
        // Input mask reformatted the digits — the set landed, retyping won't converge.
        assertEquals(
            SetTextOutcome.TRANSFORMED,
            TextInputRecipe.classifySetText("41111111", before = "", after = "4111 1111"),
        )
    }

    @Test
    fun setTextUppercaseTransformIsTransformed() {
        assertEquals(
            SetTextOutcome.TRANSFORMED,
            TextInputRecipe.classifySetText("abc", before = "", after = "ABC"),
        )
    }

    @Test
    fun setTextUnchangedFieldIsRejected() {
        assertEquals(
            SetTextOutcome.REJECTED,
            TextInputRecipe.classifySetText("hello", before = "stale", after = "stale"),
        )
    }

    @Test
    fun setTextNullReadBackIsUnverifiedNotRejected() {
        // Codex P2 (#564): no read-back (focused node gone after a re-render)
        // proves nothing either way — it must not trigger the keyevent retype
        // (double-apply risk) nor claim a transform.
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("hello", before = null, after = null),
        )
    }

    @Test
    fun setTextNullReadBackAfterPriorTextIsUnverifiedNotTransformed() {
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("hello", before = "prior", after = null),
        )
    }

    @Test
    fun setTextEmptyRequestWithNullReadBackIsUnverified() {
        assertEquals(
            SetTextOutcome.UNVERIFIED,
            TextInputRecipe.classifySetText("", before = "old", after = null),
        )
    }

    @Test
    fun keyEventFallbackViableForEmptyAndShortAscii() {
        assertTrue(TextInputRecipe.keyEventFallbackViable(""))
        assertTrue(TextInputRecipe.keyEventFallbackViable("hello world 42!"))
        assertTrue(TextInputRecipe.keyEventFallbackViable("a".repeat(TextInputRecipe.KEYEVENT_FALLBACK_MAX_CHARS)))
    }

    @Test
    fun keyEventFallbackNotViablePastPacedTypingBudget() {
        // Codex P2 round-3 (#564): 75 ms/char past ~200 chars would blow the
        // bridge's 35 s type budget mid-fallback.
        assertFalse(
            TextInputRecipe.keyEventFallbackViable("a".repeat(TextInputRecipe.KEYEVENT_FALLBACK_MAX_CHARS + 1)),
        )
    }

    @Test
    fun keyEventFallbackNotViableForNonAscii() {
        assertFalse(TextInputRecipe.keyEventFallbackViable("héllo 👋🏽 世界"))
    }

    @Test
    fun keyEventTransformedOnEmptyFieldIsUsable() {
        assertTrue(
            TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.TRANSFORMED, beforeWasEmpty = true),
        )
    }

    @Test
    fun keyEventTransformedOnNonEmptyFieldIsNotUsable() {
        // Codex P2 round-2 (#564): could be an under-deleted `old + text`
        // remnant — must descend to Maestro, not pass as a formatter reshape.
        assertFalse(
            TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.TRANSFORMED, beforeWasEmpty = false),
        )
    }

    @Test
    fun keyEventAcceptedAndUnverifiedAreUsableRejectedIsNot() {
        assertTrue(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.ACCEPTED, beforeWasEmpty = false))
        assertTrue(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.UNVERIFIED, beforeWasEmpty = false))
        assertFalse(TextInputRecipe.keyEventOutcomeUsable(SetTextOutcome.REJECTED, beforeWasEmpty = true))
    }

    @Test
    fun lowercaseLettersMapWithoutShift() {
        val stroke = TextInputRecipe.keyStrokeFor('a')
        assertEquals(29, stroke?.keyCode)
        assertFalse(stroke!!.shift)
        assertEquals(54, TextInputRecipe.keyStrokeFor('z')?.keyCode)
    }

    @Test
    fun uppercaseLettersMapWithShift() {
        val stroke = TextInputRecipe.keyStrokeFor('Z')
        assertEquals(54, stroke?.keyCode)
        assertTrue(stroke!!.shift)
    }

    @Test
    fun digitsMapToDigitKeycodes() {
        assertEquals(7, TextInputRecipe.keyStrokeFor('0')?.keyCode)
        assertEquals(16, TextInputRecipe.keyStrokeFor('9')?.keyCode)
    }

    @Test
    fun shiftedPunctuationMapsToBaseKeyWithShift() {
        val bang = TextInputRecipe.keyStrokeFor('!')
        assertEquals(8, bang?.keyCode) // KEYCODE_1
        assertTrue(bang!!.shift)
        val colon = TextInputRecipe.keyStrokeFor(':')
        assertEquals(74, colon?.keyCode) // KEYCODE_SEMICOLON
        assertTrue(colon!!.shift)
    }

    @Test
    fun emojiHasNoKeyStroke() {
        assertNull(TextInputRecipe.keyStrokeFor('世'))
    }

    @Test
    fun asciiTextIsKeyEventTypable() {
        assertTrue(TextInputRecipe.isKeyEventTypable("User@example.com, #42 (a-z)!"))
    }

    @Test
    fun emojiTextIsNotKeyEventTypable() {
        assertFalse(TextInputRecipe.isKeyEventTypable("héllo 👋🏽 世界"))
    }

    @Test
    fun emptyTextIsNotKeyEventTypable() {
        assertFalse(TextInputRecipe.isKeyEventTypable(""))
    }

    // A fresh read of an empty field that shows no hint reports null
    // accessibility text; it reads as "". Stale reads and reads without hint
    // state (API < 26) stay null, so they stay unreadable.
    @Test
    fun freshHintlessEmptyReadIsEmptyText() {
        assertEquals("", TextInputRecipe.readableText(fresh = true, text = null, showingHint = false))
        assertEquals("typed", TextInputRecipe.readableText(fresh = true, text = "typed", showingHint = false))
    }

    @Test
    fun staleOrHintUnknownReadsStayNull() {
        assertNull(TextInputRecipe.readableText(fresh = false, text = null, showingHint = false))
        assertNull(TextInputRecipe.readableText(fresh = false, text = "typed", showingHint = false))
        assertNull(TextInputRecipe.readableText(fresh = true, text = null, showingHint = null))
        assertEquals("typed", TextInputRecipe.readableText(fresh = true, text = "typed", showingHint = null))
    }

    @Test
    fun hintShowingReadKeepsTheHintText() {
        assertEquals("Placeholder", TextInputRecipe.readableText(fresh = true, text = "Placeholder", showingHint = true))
        assertNull(TextInputRecipe.readableText(fresh = true, text = null, showingHint = true))
    }

    @Test
    fun emptyClearsVerifyThroughTheNormalizedRead() {
        val plain = TextInputRecipe.readableText(fresh = true, text = null, showingHint = false)
        assertEquals("exact", TextInputRecipe.classifyVerify("", plain, null, true, secure = false))
        val placeholder = TextInputRecipe.readableText(fresh = true, text = "Placeholder", showingHint = true)
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("", placeholder, "Placeholder", true, secure = false))
        val stale = TextInputRecipe.readableText(fresh = false, text = null, showingHint = false)
        assertEquals("unreadable", TextInputRecipe.classifyVerify("", stale, null, true, secure = false))
    }

    // GH #581: verifyInput classification — exact-only truth, secure fields
    // never prove content, empty-expectation reads are hint-ambiguous.
    @Test
    fun classifyVerifyExactAndMismatch() {
        assertEquals("exact", TextInputRecipe.classifyVerify("hello", "hello", "Name", true, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("hello", "world", "Name", true, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("hello", "hel", "Name", true, secure = false))
        assertEquals("unreadable", TextInputRecipe.classifyVerify("hello", null, "Name", true, secure = false))
    }

    @Test
    fun classifyVerifySecureNeverProvesContent() {
        assertEquals("secure-masked", TextInputRecipe.classifyVerify("value-a", "•••••••", "Password", true, secure = true))
        assertEquals("secure-masked", TextInputRecipe.classifyVerify("value-a", "value-a", "Password", true, secure = true))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("value-a", "", "Password", true, secure = true))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("value-a", "Password", "Password", true, secure = true))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("value-a", "•••", "Password", true, secure = true))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("pass👍", "••••", "Password", true, secure = true))
        for (mask in listOf("•••••", "••••••")) {
            assertEquals("secure-masked", TextInputRecipe.classifyVerify("pass👍", mask, "Password", true, secure = true))
        }
        assertEquals("exact", TextInputRecipe.classifyVerify("", "", "Password", true, secure = true))
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("", "Password", "Password", true, secure = true))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("", "•••", "Password", true, secure = true))
    }

    @Test
    fun classifyVerifyEmptyExpectationIsHintAmbiguous() {
        assertEquals("exact", TextInputRecipe.classifyVerify("", "", "Enter name", true, secure = false))
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("", "Enter name", "Enter name", true, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("", "stale", "Enter name", true, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("Search", "Search", "Search", true, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("Search", "", "Search", true, secure = false))
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("Search", "Search", null, false, secure = false))
    }

    @Test
    fun classifyVerifyUnknownHintProvenanceIsInconclusiveOnlyWhenNeeded() {
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("Search", "Search", null, false, secure = false))
        assertEquals("ambiguous", TextInputRecipe.classifyVerify("", "Search", null, false, secure = false))
        assertEquals("exact", TextInputRecipe.classifyVerify("", "", null, false, secure = false))
        assertEquals("mismatch", TextInputRecipe.classifyVerify("Search", "Other", null, false, secure = false))
    }

    @Test
    fun verifyObservationRequiresVerdictAndHintProvenanceAgreement() {
        val ambiguous = TextInputRecipe.verifyObservation("Search", "Search", "Search", true, secure = false)
        val exact = TextInputRecipe.verifyObservation("Search", "Search", null, true, secure = false)
        assertFalse(ambiguous == exact)
        assertEquals(exact, TextInputRecipe.verifyObservation("Search", "Search", null, true, secure = false))
    }

    @Test
    fun recordedDescriptorRequiresPresentRecognizedIdentity() {
        assertTrue(
            TextInputRecipe.recordedDescriptorAgrees(
                7,
                12,
                "android.widget.EditText",
                "email",
                7,
                12,
                "android.widget.EditText",
                "email",
            ),
        )
        assertFalse(
            TextInputRecipe.recordedDescriptorAgrees(
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
            ),
        )
        assertFalse(
            TextInputRecipe.recordedDescriptorAgrees(
                7,
                null,
                "android.widget.EditText",
                null,
                7,
                null,
                "android.widget.EditText",
                null,
            ),
        )
        assertFalse(
            TextInputRecipe.recordedDescriptorAgrees(
                7,
                12,
                "EditText",
                null,
                7,
                12,
                "EditText",
                null,
            ),
        )
        assertFalse(
            TextInputRecipe.recordedDescriptorAgrees(
                7,
                12,
                "android.widget.EditText",
                "runtime-email",
                7,
                12,
                "android.widget.EditText",
                null,
            ),
        )
        assertFalse(
            TextInputRecipe.recordedDescriptorAgrees(
                7,
                12,
                "android.widget.AutoCompleteTextView",
                "email",
                7,
                12,
                "android.widget.EditText",
                "email",
            ),
        )
    }

    @Test
    fun targetResolutionRejectsCrossClassDuplicatesAndMovedReplacement() {
        val frame = TextInputRecipe.TargetFrame(0, 100, 300, 144)
        val duplicate = TextInputRecipe.resolveIdentifier(
            listOf(
                TextInputRecipe.TargetIdentity("android.widget.EditText", "email", frame),
                TextInputRecipe.TargetIdentity("android.widget.AutoCompleteTextView", "email", frame),
            ),
            "android.widget.EditText",
            "email",
            frame,
            requireFrame = true,
        )
        val moved = TextInputRecipe.resolveIdentifier(
            listOf(
                TextInputRecipe.TargetIdentity(
                    "android.widget.EditText",
                    "email",
                    TextInputRecipe.TargetFrame(0, 400, 300, 444),
                ),
            ),
            "android.widget.EditText",
            "email",
            frame,
            requireFrame = true,
        )
        val shiftedRecordedTarget = TextInputRecipe.resolveIdentifier(
            listOf(
                TextInputRecipe.TargetIdentity(
                    "android.widget.EditText",
                    "email",
                    TextInputRecipe.TargetFrame(0, 400, 300, 444),
                ),
            ),
            "android.widget.EditText",
            "email",
            null,
            requireFrame = false,
        )
        assertEquals(TextInputRecipe.TargetResolution.Ambiguous, duplicate)
        assertEquals(TextInputRecipe.TargetResolution.Absent, moved)
        assertEquals(TextInputRecipe.TargetResolution.Unique(0), shiftedRecordedTarget)
    }
}
