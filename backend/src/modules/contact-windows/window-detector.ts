import { VisibilitySample } from "../visibility/types";
import { CoarseWindow } from "./types";

export class WindowDetector {
  public detectCoarseWindows(samples: VisibilitySample[]): CoarseWindow[] {
    if (samples.length === 0) return [];
    
    const windows: CoarseWindow[] = [];
    let currentWindow: Partial<CoarseWindow> | null = null;
    
    const observationStart = new Date(samples[0]!.timestamp);
    const observationEnd = new Date(samples[samples.length - 1]!.timestamp);
    
    for (let i = 0; i < samples.length; i++) {
      const current = samples[i]!;
      const previous = i > 0 ? samples[i - 1] : null;

      // Handle start of observation
      if (i === 0 && current.visible) {
        currentWindow = {
          startsVisible: true,
          endsVisible: false, // will update later
          maxElevationDeg: current.elevationDeg,
          observationStart,
          observationEnd
        };
      } else if (previous && !previous.visible && current.visible) {
        // false -> true (AOS transition)
        currentWindow = {
          startsVisible: false,
          endsVisible: false,
          aosBracket: { type: "AOS", before: previous, after: current },
          maxElevationDeg: current.elevationDeg,
          observationStart,
          observationEnd
        };
      }

      // Track max elevation if in a window
      if (currentWindow && current.visible) {
        if (currentWindow.maxElevationDeg === undefined || current.elevationDeg > currentWindow.maxElevationDeg) {
          currentWindow.maxElevationDeg = current.elevationDeg;
        }
      }

      // Handle LOS transition
      if (previous && previous.visible && !current.visible) {
        if (currentWindow) {
          currentWindow.losBracket = { type: "LOS", before: previous, after: current };
          windows.push(currentWindow as CoarseWindow);
          currentWindow = null;
        }
      }
    }
    
    // Handle ends visible
    if (currentWindow) {
      currentWindow.endsVisible = true;
      windows.push(currentWindow as CoarseWindow);
    }

    return windows;
  }
}
