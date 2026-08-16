declare module 'satellite.js' {
  export function twoline2satrec(line1: string, line2: string): any;
  export function propagate(satrec: any, date: Date): any;
  export function gstime(date: Date): number;
  export function eciToGeodetic(eci: any, gmst: number): any;
  export function geodeticToEcf(geodetic: any): any;
  export function eciToEcf(eci: any, gmst: number): any;
  export function ecfToLookAngles(observerGeodetic: any, satelliteEcf: any): any;
  export const constants: any;
  export function degreesLat(radians: number): number;
  export function degreesLong(radians: number): number;
}
