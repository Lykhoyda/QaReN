package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// AI-489: an input the app keeps fully transparent is not visible to the user,
// so the exact UiAutomator binding never sees it. It is typed into only when it
// is the app's own enabled, editable, focused input with a real frame.
class FocusedHiddenInputTest {
    private fun eligible(
        isInputClass: Boolean = true,
        classMatches: Boolean = true,
        editable: Boolean = true,
        enabled: Boolean = true,
        focused: Boolean = true,
        visibleToUser: Boolean = false,
        boundsEmpty: Boolean = false,
        packageMatches: Boolean = true,
        frameMatches: Boolean = true,
    ) = FocusedHiddenInput.eligible(
        isInputClass = isInputClass,
        classMatches = classMatches,
        editable = editable,
        enabled = enabled,
        focused = focused,
        visibleToUser = visibleToUser,
        boundsEmpty = boundsEmpty,
        packageMatches = packageMatches,
        frameMatches = frameMatches,
    )

    @Test fun aFocusedHiddenInputOfTheAppWithARealFrameIsEligible() = assertTrue(eligible())

    @Test fun aNonInputClassIsNotEligible() = assertFalse(eligible(isInputClass = false))

    @Test fun anotherClassThanTheSnapshotsIsNotEligible() = assertFalse(eligible(classMatches = false))

    @Test fun aReadOnlyNodeIsNotEligible() = assertFalse(eligible(editable = false))

    @Test fun aDisabledInputIsNotEligible() = assertFalse(eligible(enabled = false))

    @Test fun anUnfocusedInputIsNotEligible() = assertFalse(eligible(focused = false))

    // A visible input belongs to the exact binding, never to this path.
    @Test fun aVisibleInputIsNotEligible() = assertFalse(eligible(visibleToUser = true))

    // A scrolled-out node keeps an empty clipped rect.
    @Test fun anEmptyFrameIsNotEligible() = assertFalse(eligible(boundsEmpty = true))

    @Test fun anotherPackagesInputIsNotEligible() = assertFalse(eligible(packageMatches = false))

    @Test fun aFrameOtherThanTheSnapshotsIsNotEligible() = assertFalse(eligible(frameMatches = false))
}
