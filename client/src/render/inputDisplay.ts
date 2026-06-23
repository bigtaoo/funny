/**
 * Build the display string for a canvas-rendered text input field.
 *
 * When the field is focused (caretOn cycles true/false via the blink timer),
 * the cursor '|' is appended to the current text. If the result would be an
 * empty string (no text AND cursor blink-off phase), the placeholder is shown
 * instead so the field never appears completely blank.
 *
 * Usage:
 *   const display = caretDisplay(this.text, this.caretOn, t('field.placeholder'));
 */
export function caretDisplay(text: string, caretOn: boolean, placeholder: string): string {
  const withCaret = text + (caretOn ? '|' : '');
  return withCaret || placeholder;
}
