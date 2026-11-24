import { useCallback, useEffect, useRef } from "react";
import { useBlocker, type BlockerFunction } from "react-router-dom";
import { Button, Modal } from "./ui";

/**
 * Asks before leaving the page while there are unsaved changes: sidebar and other links, notifications,
 * the browser's Back and Forward buttons, and closing or reloading the tab.
 * `when` can be a function, read at the moment someone tries to leave (handy with a ref that's cleared just before
 * a page navigates away by itself after saving). Moves within the same page (e.g. ?tab=) aren't blocked.
 */
export function LeaveGuard({ when, message = "You have unsaved changes. Leave without saving?" }: { when: boolean | (() => boolean); message?: string }) {
  const whenRef = useRef(when);
  whenRef.current = when;
  const active = useCallback(() => {
    const w = whenRef.current;
    return typeof w === "function" ? w() : w;
  }, []);

  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => active() && currentLocation.pathname !== nextLocation.pathname, [active]);
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!active()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [active]);

  if (blocker.state !== "blocked") return null;
  return (
    <Modal
      title="Leave without saving?"
      onClose={() => blocker.reset?.()}
      actions={
        <>
          <Button variant="quiet" onClick={() => blocker.reset?.()}>
            Stay
          </Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            Leave
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
