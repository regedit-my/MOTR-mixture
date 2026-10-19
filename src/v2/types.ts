export interface Point {
  x: number;
  y: number;
}

export interface PathData {
  points: Point[];
}

export interface PresetMap {
  paths: PathData[];
}

export interface PresetData {
  maps: Record<string, PresetMap>;
}

export interface Route {
  points: Point[];
  length: number;
}

export interface Participant {
  id: number;
  name: string;
  defaultLabel: string;
}
