import { VisibilitySample } from "../visibility/types";

export class Refinement {
  /**
   * Refines the exact boundary timestamp using binary search.
   * @param before The sample before the transition
   * @param after The sample after the transition
   * @param visibilityMathFn A function that returns whether a given timestamp is visible
   * @param transitionType "AOS" (false->true) or "LOS" (true->false)
   * @param toleranceSeconds The accuracy tolerance (default 1 second)
   * @returns The exact Date where the transition occurred
   */
  public async refineTransition(
    before: VisibilitySample,
    after: VisibilitySample,
    visibilityMathFn: (t: Date) => Promise<boolean>,
    transitionType: "AOS" | "LOS",
    toleranceSeconds: number = 1
  ): Promise<Date> {
    let lowMs = new Date(before.timestamp).getTime();
    let highMs = new Date(after.timestamp).getTime();

    while (highMs - lowMs > toleranceSeconds * 1000) {
      const midMs = Math.floor((lowMs + highMs) / 2);
      const midTime = new Date(midMs);
      
      const isVisible = await visibilityMathFn(midTime);

      if (transitionType === "AOS") {
        // false -> true
        if (isVisible) {
          highMs = midMs; // Transition happened before or exactly at mid
        } else {
          lowMs = midMs; // Transition happened after mid
        }
      } else {
        // true -> false (LOS)
        if (isVisible) {
          lowMs = midMs; // Transition happened after mid
        } else {
          highMs = midMs; // Transition happened before or exactly at mid
        }
      }
    }

    return new Date(highMs); // The point at which the state officially changes
  }
}
