import { VisibilitySample } from "../visibility/types";

export type TransitionType = "AOS" | "LOS";

export type Transition =
  | {
      type: "AOS";
      before: VisibilitySample;
      after: VisibilitySample;
    }
  | {
      type: "LOS";
      before: VisibilitySample;
      after: VisibilitySample;
    };

export interface CoarseWindow {
  aosBracket?: Transition;
  losBracket?: Transition;
  maxElevationDeg: number;
  startsVisible: boolean;
  endsVisible: boolean;
  observationStart: Date;
  observationEnd: Date;
}
