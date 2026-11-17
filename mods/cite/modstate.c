// Reports the keyboard modifiers and left mouse button, for mods/cite.
// `modstate wait`: waits (up to 2 min) for the left button to come up and names every
// modifier held at any point while it was down: "cmd alt ctrl shift", "-" for none,
// then " down" if the button was down when it started.
// No permissions needed: CGEventSource state is readable by any process.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  CGEventSourceStateID s = kCGEventSourceStateCombinedSessionState;
  CGEventFlags seen = CGEventSourceFlagsState(s);
  int down = CGEventSourceButtonState(s, kCGMouseButtonLeft);
  if (argc > 1 && strcmp(argv[1], "wait") == 0) {
    for (int i = 0; i < 12000 && CGEventSourceButtonState(s, kCGMouseButtonLeft); i++) {
      seen |= CGEventSourceFlagsState(s);
      usleep(10000);
    }
  }
  char out[64] = "";
  if (seen & kCGEventFlagMaskCommand) strcat(out, "cmd ");
  if (seen & kCGEventFlagMaskAlternate) strcat(out, "alt ");
  if (seen & kCGEventFlagMaskControl) strcat(out, "ctrl ");
  if (seen & kCGEventFlagMaskShift) strcat(out, "shift ");
  printf("%s%s\n", out[0] ? out : "- ", down ? "down" : "");
  return 0;
}
