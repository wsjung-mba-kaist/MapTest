/** Minimal typings for clipper-lib 6.4 (JS port of Angus Johnson's Clipper), as used by scripts/lib/clip.ts. */
declare module 'clipper-lib' {
  export interface IntPoint { X: number; Y: number }
  export type Path = IntPoint[];
  export type Paths = Path[];
  export enum ClipType { ctIntersection = 0, ctUnion = 1, ctDifference = 2, ctXor = 3 }
  export enum PolyType { ptSubject = 0, ptClip = 1 }
  export enum PolyFillType { pftEvenOdd = 0, pftNonZero = 1, pftPositive = 2, pftNegative = 3 }
  export enum JoinType { jtSquare = 0, jtRound = 1, jtMiter = 2 }
  export enum EndType { etOpenSquare = 0, etOpenRound = 1, etOpenButt = 2, etClosedLine = 3, etClosedPolygon = 4 }
  export class PolyNode {
    Contour(): Path;
    Childs(): PolyNode[];
    IsHole(): boolean;
    IsOpen: boolean;
  }
  export class PolyTree extends PolyNode {
    Clear(): void;
    Total(): number;
  }
  export class Clipper {
    constructor(initOptions?: number);
    StrictlySimple: boolean;
    AddPath(path: Path, polyType: PolyType, closed: boolean): boolean;
    AddPaths(paths: Paths, polyType: PolyType, closed: boolean): boolean;
    Execute(clipType: ClipType, solution: Paths | PolyTree, subjFillType?: PolyFillType, clipFillType?: PolyFillType): boolean;
    static Area(path: Path): number;
    static CleanPolygons(paths: Paths, distance?: number): Paths;
    static SimplifyPolygons(paths: Paths, fillType?: PolyFillType): Paths;
    static Orientation(path: Path): boolean;
  }
  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    ArcTolerance: number;
    AddPath(path: Path, joinType: JoinType, endType: EndType): void;
    AddPaths(paths: Paths, joinType: JoinType, endType: EndType): void;
    Execute(solution: Paths | PolyTree, delta: number): void;
    Clear(): void;
  }
  export namespace JS {
    function Clean(paths: Paths, delta: number): Paths;
    function Lighten(paths: Paths, tolerance: number): Paths;
  }
}
