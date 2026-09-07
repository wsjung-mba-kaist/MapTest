// Procedural Parisian facade. Injected into MeshStandardMaterial via onBeforeCompile.
// Inputs (varyings): vUvM = (metres along wall, metres above ground), vMetaV = (floorH, levels, wallLength, seed+style*256),
// vColor = (tint rgb, flag/255). Outputs: fDiffuse, fRoughness, fMetalness, fEmissive, fAo.

float ihash(uint a, uint b) { uint h = a * 2654435761u ^ b * 2246822519u; h ^= h >> 13u; h *= 3266489917u; h ^= h >> 16u; return float(h & 0xFFFFu) / 65536.0; }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Share of windows lit at a local hour: the LIT_ANCHORS table of shared/nightlife.ts (keep both in sync).
float litProbability(float h) {
  h = mod(h, 24.0);
  float hs[17] = float[17](0.,1.,2.,3.,4.,5.,6.,7.,8.,17.,18.,19.,20.,21.,22.,23.,24.);
  float ps[17] = float[17](0.20,0.15,0.10,0.07,0.06,0.08,0.12,0.10,0.05,0.05,0.09,0.15,0.28,0.40,0.40,0.35,0.20);
  for (int i = 0; i < 16; i++) if (h >= hs[i] && h <= hs[i + 1]) return mix(ps[i], ps[i + 1], (h - hs[i]) / (hs[i + 1] - hs[i]));
  return 0.2;
}
// Shop-front lighting factor: open until 20:00 (restaurants 01:00), a security light after; shared/nightlife.ts shopOpen().
float shopOpenF(float hour, float restaurant) {
  float close = restaurant > 0.5 ? 25.0 : 20.0;
  float hh = hour < 6.0 ? hour + 24.0 : hour;
  if (hh < 8.0) return 0.15;
  if (hh < 9.5) return 0.5;
  if (hh < close - 0.5) return 1.0;
  if (hh < close) return 1.0 - (hh - (close - 0.5)) / 0.5 * 0.85;
  return 0.15;
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
// Rectangle mask with soft anti-aliased edge (px = derivative-based width).
float rectMask(vec2 p, vec2 lo, vec2 hi, float aa) {
  vec2 a = smoothstep(lo - aa, lo + aa, p) * (1.0 - smoothstep(hi - aa, hi + aa, p));
  return a.x * a.y;
}
// Window opening: a rectangle, or (arch > 0.5) a rectangle with a semicircular head inscribed in its width.
float archMask(vec2 p, vec2 lo, vec2 hi, float aa, float arch) {
  if (arch < 0.5) return rectMask(p, lo, hi, aa);
  float r = (hi.x - lo.x) * 0.5;
  vec2 c = vec2((lo.x + hi.x) * 0.5, hi.y - r);
  float body = rectMask(p, lo, vec2(hi.x, c.y), aa);
  float head = (1.0 - smoothstep(r - aa, r + aa, length(p - c))) * step(c.y, p.y);
  return max(body, head);
}

// Photographic micro-detail (CC0 PBR sets loaded once; uHasFacadeTex flips to 1 when ready).
uniform float uHasFacadeTex;
uniform sampler2D uWallC, uWallR, uPlasterN;      // plaster_grey_04: fine limestone/plaster grain
uniform sampler2D uBaseC, uBaseN;                 // large_sandstone_blocks: rusticated ground-floor trim sheet
uniform sampler2D uSlateC, uSlateN, uSlateR;      // roof_slates_02
uniform vec3 uWallMean, uBaseMean;                // mean linear albedo, so detail can be luminance-normalised

struct Facade { vec3 color; float rough; float metal; vec3 emissive; float ao; vec3 n; };

Facade shadeWall(vec2 uv, vec4 meta, vec3 tint, float flag, float night, float seedTime, vec3 viewTS) {
  Facade f;
  float floorH = max(2.4, meta.x);
  float levels = max(1.0, meta.y);
  float wallLen = max(0.5, meta.z);
  float seed = mod(meta.w, 256.0);
  // meta.w = seed + style * 256 with seed in 0..255, so the style is the plain quotient.
  // Rounding here (the old `+ 0.5`) pushed every building with seed >= 128 into the next style.
  float style = floor(meta.w / 256.0);
  float eave = 4.3 + (levels - 1.0) * floorH;
  if (levels < 1.5) eave = max(floorH, 3.0);
  float aa = max(fwidth(uv.x), fwidth(uv.y)) * 0.75 + 0.002;
  float u = uv.x, v = uv.y;

  // ---- stone base colour with courses and per-block variation
  vec3 stone = tint;
  // monuments are built of big ashlar blocks (0.9 m courses); Haussmann fronts of finer limestone
  float courseH = style == 4.0 ? 0.9 : 0.55;
  float course = floor(v / courseH);
  float blockW = style == 4.0 ? 1.8 : 1.1;
  float blockU = floor((u + mod(course, 2.0) * blockW * 0.5) / blockW);
  float blockVar = (hash21(vec2(blockU, course) + seed) - 0.5) * 0.06;
  stone *= 1.0 + blockVar;
  float jointV = smoothstep(0.0, aa * 2.0, abs(fract(v / courseH) - 0.5) * courseH - (courseH * 0.5 - 0.012));
  float jointU = smoothstep(0.0, aa * 2.0, abs(fract((u + mod(course, 2.0) * blockW * 0.5) / blockW) - 0.5) * blockW - (blockW * 0.5 - 0.010));
  float joints = max(jointV, jointU) * (1.0 - smoothstep(0.01, 0.05, aa));
  stone *= 1.0 - joints * 0.10;
  stone *= 0.93 + 0.07 * noise2(vec2(u * 0.7, v * 0.7) + seed);   // weathering
  stone *= 1.0 - 0.10 * smoothstep(1.0, 0.0, v);                   // dirt at the base
  // Plaster/limestone grain: luminance-normalised so the building tint survives, plus a little of its staining colour.
  vec3 n = vec3(0.0, 0.0, 1.0);
  float texAmt = uHasFacadeTex;
  float grainR = 0.5;
  if (texAmt > 0.5) {
    vec2 grainUv = (uv + vec2(seed * 0.37, seed * 0.61)) / 2.6;
    vec3 grain = texture2D(uWallC, grainUv).rgb / max(uWallMean, vec3(0.02));
    float gl = max(dot(grain, vec3(0.3333)), 0.02);
    stone *= mix(1.0, gl, 0.55) * mix(vec3(1.0), grain / gl, 0.25);
    grainR = texture2D(uWallR, grainUv).r;
    n = texture2D(uPlasterN, grainUv).xyz * 2.0 - 1.0;
    n.xy *= 0.55;
  }
  vec3 color = stone;
  float rough = mix(0.85, 0.65 + 0.35 * grainR, texAmt), metal = 0.0, ao = 1.0;
  vec3 emissive = vec3(0.0);

  // Night floodlighting of monuments (style 4) and bridge stone (baked with the plinth flag 3): warm uplight that
  // fades over the first ~8 m, as the projectors at the foot of the Trocadéro, the Ecole Militaire or the Iena arches do.
  if ((style == 4.0 || flag > 2.5) && night > 0.001 && v >= 0.0) {
    emissive += stone * vec3(1.0, 0.80, 0.58) * 0.30 * exp(-max(v, 0.0) / 8.0) * night;
  }
  // Below-ground extension / plinth: darker stone, nothing else.
  if (v < 0.0 || flag > 2.5) { f.color = stone * 0.8; f.rough = 0.9; f.metal = 0.0; f.emissive = emissive; f.ao = 1.0; f.n = n; return f; }

  // ---- floor bookkeeping
  float floorIdx = v < 4.3 ? 0.0 : 1.0 + floor((v - 4.3) / floorH);
  if (levels < 1.5) floorIdx = 0.0;
  float floorBase = floorIdx == 0.0 ? 0.0 : 4.3 + (floorIdx - 1.0) * floorH;
  float thisFloorH = floorIdx == 0.0 ? (levels < 1.5 ? eave : 4.3) : floorH;
  float fv = v - floorBase;                       // metres above this floor's slab
  bool aboveEave = v > eave - 0.02;
  bool topFloor = floorIdx >= levels - 0.5;

  // ---- bays
  float bayTarget = style == 1.0 ? 1.6 : (style == 4.0 ? 4.2 : 3.2);
  float nBays = max(1.0, floor(wallLen / bayTarget + 0.5));
  float bayW = wallLen / nBays;
  float bayIdx = floor(u / bayW);
  float bu = u - bayIdx * bayW;                   // metres inside the bay
  float bayHash = hash21(vec2(bayIdx, floorIdx) + seed * 0.37);
  bool narrowWall = wallLen < 2.0;

  // ---- monument piers: a 0.9 m pilaster at every bay boundary, the wall between them 0.25 m further back.
  // The recess is a parallax lookup like the window reveals: where the shifted point lands on a pier we see its side.
  float pilW = 0.9, pilSide = 0.0, onPil = 0.0;
  float bu0 = bu, fv0 = fv;
  bool grand = style == 4.0 && !narrowWall && wallLen > 6.0 && levels > 1.5;
  if (grand) {
    float edge = min(bu, bayW - bu);
    onPil = 1.0 - smoothstep(pilW * 0.5 - aa, pilW * 0.5 + aa, edge);
    if (onPil < 0.5) {
      vec2 sh = vec2(bu, fv) - viewTS.xy / max(viewTS.z, 0.08) * 0.25;
      if (sh.x < pilW * 0.5 || sh.x > bayW - pilW * 0.5) pilSide = 1.0; else { bu = sh.x; fv = sh.y; }
    }
  }

  // Rusticated ashlar on the ground floor: one trim sheet spans the storey (plinth band at the bottom, moulding
  // under the first-floor string course), repeated every 4.3 m along the wall.
  if (texAmt > 0.5 && floorIdx == 0.0 && style != 1.0 && !narrowWall && levels > 1.5) {
    vec2 baseUv = vec2((u + seed * 1.3) / 4.3, clamp(fv / thisFloorH, 0.0, 1.0));
    vec3 bC = texture2D(uBaseC, baseUv).rgb / max(uBaseMean, vec3(0.02));
    float bl = max(dot(bC, vec3(0.3333)), 0.02);
    color *= mix(1.0, bl, 0.5) * mix(vec3(1.0), bC / bl, 0.15);
    vec3 bn = texture2D(uBaseN, baseUv).xyz * 2.0 - 1.0;
    bn.xy *= 0.8;
    n = bn;
  }
  // Monument base: channelled rustication (deep horizontal joints every 0.75 m) over a darker plinth.
  if (style == 4.0 && floorIdx == 0.0 && !narrowWall && levels > 1.5) {
    float chan = 1.0 - smoothstep(0.0, aa * 2.0, abs(fract(fv / 0.75) - 0.5) * 0.75 - 0.03);
    color *= 1.0 - chan * 0.22 * (1.0 - smoothstep(0.02, 0.08, aa));
    n.y += chan * 0.4 * sign(fract(fv / 0.75) - 0.5);
    color *= 1.0 - 0.12 * (1.0 - smoothstep(1.1, 1.3, fv));
  }

  // ---- windows
  float winW = clamp(bayW * 0.42, 0.9, 1.5);
  float winH = min(2.25, thisFloorH - 0.85);
  float sill = 0.9;
  if (style == 1.0) { winW = bayW - 0.18; winH = thisFloorH - 0.55; sill = 0.4; }
  if (style == 4.0) { winW = clamp(bayW * 0.38, 1.0, 1.8); winH = min(3.2, thisFloorH - 1.0); sill = 1.0; if (grand) winW = min(winW, bayW - pilW - 0.5); }
  if (style == 2.0) { winW = clamp(bayW * 0.34, 0.8, 1.2); winH = min(1.8, thisFloorH - 0.9); }
  bool shopBay = false;
  if (floorIdx == 0.0 && style != 1.0) {
    // Ground floor: shopfront on commercial-looking walls, otherwise tall windows and a door.
    bool shop = mod(seed * 7.0 + bayIdx * 13.0, 10.0) < 5.0 && wallLen > 6.0 && style != 4.0;
    shopBay = shop;
    if (shop) { winW = bayW - 0.7; winH = 3.1; sill = 0.3; } else { winW = clamp(bayW * 0.4, 0.9, 1.4); winH = min(2.9, thisFloorH - 1.0); sill = 0.7; }
  }
  bool topAtticSmall = topFloor && style == 0.0 && levels > 5.5;
  if (topAtticSmall) { winH = min(winH, 1.5); }
  vec2 wlo = vec2((bayW - winW) * 0.5, sill);
  vec2 whi = vec2((bayW + winW) * 0.5, sill + winH);
  bool hasWindow = !narrowWall && !aboveEave && bayHash > 0.06 && thisFloorH > 2.2 && onPil < 0.5;
  // monuments: round-headed openings on the ground floor (and the piano nobile of low wings)
  float arch = (style == 4.0 && (floorIdx == 0.0 || (floorIdx == 1.0 && levels < 3.5)) && winH > winW * 1.2) ? 1.0 : 0.0;
  float win = hasWindow ? archMask(vec2(bu, fv), wlo, whi, aa, arch) : 0.0;
  float frameT = style == 1.0 ? 0.05 : 0.09;
  // Parallax reveal: the glass sits `depthR` behind the wall plane. Shift the lookup along the tangent-space
  // view vector; where the shifted point leaves the opening we are looking at the reveal's side wall.
  float depthR = style == 1.0 ? 0.03 : (floorIdx == 0.0 ? 0.32 : 0.24);
  vec2 pq = vec2(bu, fv) - viewTS.xy / max(viewTS.z, 0.08) * depthR;
  bool inOpening = win > 0.5;
  bool hitGlass = inOpening && archMask(pq, wlo, whi, aa, arch) > 0.5;
  float revealSide = (inOpening && !hitGlass) ? 1.0 : 0.0;
  vec2 gq = hitGlass ? pq : vec2(bu, fv);
  float glass = hasWindow ? archMask(gq, wlo + frameT, whi - frameT, aa, arch) * (1.0 - revealSide) : 0.0;
  // Split glass into two casements + transom (evaluated on the recessed plane).
  float mullion = hasWindow ? (1.0 - smoothstep(0.0, aa * 2.0, abs(gq.x - bayW * 0.5) - 0.03)) : 0.0;
  float transom = (style == 1.0) ? 0.0 : (1.0 - smoothstep(0.0, aa * 2.0, abs(gq.y - (sill + winH * 0.68)) - 0.03));
  glass *= (1.0 - max(mullion, transom) * (style == 1.0 ? 0.0 : 1.0));

  // Reveal shading: the side walls of the opening are in shadow, the glass darkens under the lintel.
  float reveal = revealSide * 0.62 + win * (1.0 - revealSide) * smoothstep(whi.y - 0.30, whi.y, gq.y) * 0.35;

  vec3 frameCol = style == 1.0 ? vec3(0.25, 0.27, 0.3) : mix(vec3(0.92, 0.9, 0.85), tint * 1.05, 0.3);
  // ---- night: which windows are lit follows the hour (shared/nightlife.ts); each window keeps a fixed draw so the
  // same ones switch off first as the evening goes on. Colour temperature, brightness, curtains and shutters vary.
  float wh = hash21(vec2(bayIdx * 1.7, floorIdx * 2.3) + seed);
  float lit = step(wh, litProbability(uHour)) * night;
  float kind = hash21(vec2(bayIdx * 3.1, floorIdx * 1.9) + seed * 1.7);
  vec3 litCol = kind < 0.6 ? vec3(1.0, 0.60, 0.30) : (kind < 0.85 ? vec3(1.0, 0.78, 0.55) : vec3(0.75, 0.85, 1.0));   // 2700 K / 3500 K / TV
  float flick = kind < 0.85 ? 1.0 : 0.85 + 0.15 * sin(uTime * 7.0 + wh * 40.0);
  float bh = hash11(bayIdx + floorIdx * 13.0 + seed);
  float bright = bh > 0.92 ? 2.5 + (bh - 0.92) * 12.5 : 0.35 + 1.3 * bh * bh;   // a few bright rooms bloom like in photographs
  float curtain = step(0.6, hash21(vec2(floorIdx * 5.3, bayIdx * 0.7) + seed * 2.3));   // 40 % curtained
  float shutter = step(0.8, hash21(vec2(bayIdx * 2.9, floorIdx * 4.1) + seed * 3.1));   // 20 % shuttered
  float folds = 0.8 + 0.2 * sin((gq.x - wlo.x) / max(winW, 0.1) * 18.85);            // curtain folds
  float ceiling = mix(0.55, 1.0, smoothstep(wlo.y, whi.y, gq.y));                       // ceiling light: brighter up top
  vec3 winEm = litCol * bright * ceiling * flick;
  winEm = mix(winEm, mix(winEm, vec3(dot(winEm, vec3(0.333))), 0.35) * 0.5 * folds, curtain);
  winEm *= 1.0 - shutter;
  if (shopBay) {
    // shop fronts: cool-white display lighting while open (restaurants until 01:00), a security light after
    float rest = step(0.7, hash11(seed * 3.0 + bayIdx * 0.53));
    float open = shopOpenF(uHour, rest);
    winEm = vec3(0.95, 0.93, 0.85) * mix(0.35, 1.5 + 1.0 * bh, open) * mix(0.9, 1.1, smoothstep(wlo.y, whi.y, gq.y));
    lit = night;
  }
  vec3 glassCol = mix(vec3(0.07, 0.085, 0.10), vec3(0.16, 0.17, 0.18), hash21(vec2(bayIdx, floorIdx) * 7.0 + seed));
  // Curtains / interiors: warm tint behind some windows; closed shutters read as a dull grey panel.
  glassCol = mix(glassCol, vec3(0.32, 0.28, 0.22), step(0.8, bayHash) * 0.5);
  glassCol = mix(glassCol, vec3(0.20, 0.19, 0.17), shutter * (1.0 - float(shopBay)));
  color = mix(color, frameCol, win);
  color = mix(color, glassCol, glass);
  color *= 1.0 - reveal * (1.0 - glass) * 0.6;
  if (arch > 0.5 && hasWindow) {
    // keystone and voussoir line over the arch
    float ks = rectMask(vec2(bu, fv), vec2(bayW * 0.5 - 0.16, whi.y - 0.06), vec2(bayW * 0.5 + 0.16, whi.y + 0.34), aa);
    color = mix(color, tint * 1.12, ks);
  }
  rough = mix(rough, mix(0.18, 0.7, shutter), glass);
  metal = mix(metal, 0.05, glass);
  emissive += glass * lit * winEm;
  // Rain streaks below the sills; openings and glass stay flat.
  if (hasWindow) {
    float below = sill - fv;
    float streak = smoothstep(-0.03, 0.03, below) * (1.0 - smoothstep(0.25, 1.1, below))
      * rectMask(vec2(bu, 0.5), vec2(wlo.x - 0.08, 0.0), vec2(whi.x + 0.08, 1.0), aa)
      * (0.3 + 0.7 * noise2(vec2(u * 7.0, floorIdx * 3.1 + seed)));
    color *= 1.0 - streak * 0.16;
  }
  n.xy *= 1.0 - max(glass, win * 0.6);

  // ---- Haussmann horizontals: continuous balconies (floors 2 and 5), string courses, cornice
  if (style == 0.0 || style == 4.0) {
    bool balconyFloor = style == 0.0 && (floorIdx == 2.0 || (floorIdx == 5.0 && levels > 5.5));
    // Stone string course under every floor line.
    float band = rectMask(vec2(bu, fv), vec2(-1.0, -0.02), vec2(bayW + 1.0, 0.22), aa);
    color = mix(color, tint * 1.06, band * 0.9);
    color *= 1.0 - smoothstep(0.30, 0.22, fv) * step(0.22, fv) * 0.15;   // shadow under the band
    if (balconyFloor && !aboveEave) {
      // Railing: 0.95 m of dark ironwork with vertical bars every 12 cm, on top of a 0.2 m slab.
      float slab = rectMask(vec2(bu, fv), vec2(-1.0, 0.0), vec2(bayW + 1.0, 0.28), aa);
      float rail = rectMask(vec2(bu, fv), vec2(-1.0, 0.28), vec2(bayW + 1.0, 1.15), aa);
      float bars = mix(smoothstep(0.02, 0.02 + aa, abs(fract(u / 0.12) - 0.5) * 0.12 - 0.012), 0.5, smoothstep(0.015, 0.06, aa));
      float ironwork = rail * (1.0 - bars * 0.72);
      float topRail = rectMask(vec2(bu, fv), vec2(-1.0, 1.08), vec2(bayW + 1.0, 1.15), aa);
      color = mix(color, tint * 1.08, slab);
      color = mix(color, vec3(0.06, 0.06, 0.065), max(ironwork, topRail));
      rough = mix(rough, 0.55, max(ironwork, topRail));
      metal = mix(metal, 0.4, max(ironwork, topRail));
    } else if (hasWindow && floorIdx > 0.5) {
      // Individual window guard rails.
      float rail = rectMask(vec2(bu, fv), vec2(wlo.x - 0.05, sill - 0.02), vec2(whi.x + 0.05, sill + 0.9), aa) * (1.0 - glass);
      float bars = mix(smoothstep(0.02, 0.02 + aa, abs(fract(u / 0.11) - 0.5) * 0.11 - 0.010), 0.5, smoothstep(0.015, 0.06, aa));
      float guard = rail * (1.0 - bars * 0.75) * step(fv, sill + 0.9);
      color = mix(color, vec3(0.07, 0.07, 0.075), guard * step(sill, fv) * 0.9);
    }
    // Cornice: 0.7 m of pale stone under the eave with a dark shadow line.
    float cornice = smoothstep(eave - 0.75, eave - 0.7, v) * (1.0 - smoothstep(eave - 0.05, eave, v));
    color = mix(color, tint * 1.10, cornice);
    color *= 1.0 - (smoothstep(eave - 0.95, eave - 0.75, v) * (1.0 - smoothstep(eave - 0.75, eave - 0.6, v))) * 0.35;
    if (style == 4.0) {
      // Entablature: a frieze with dentils between the architrave and the cornice.
      float frieze = smoothstep(eave - 1.75, eave - 1.7, v) * (1.0 - smoothstep(eave - 0.8, eave - 0.75, v));
      color = mix(color, tint * 1.03, frieze);
      float dent = frieze * step(0.45, fract(u / 0.32)) * smoothstep(eave - 1.05, eave - 1.0, v) * (1.0 - smoothstep(eave - 0.82, eave - 0.8, v));
      color *= 1.0 - dent * 0.35 * (1.0 - smoothstep(0.02, 0.08, aa));
      // Piers: fluted face with a capital band under the floor line; the recessed wall next to them in shadow.
      if (grand) {
        if (onPil > 0.5) {
          float x = min(bu0, bayW - bu0) / (pilW * 0.5);
          float flute = 0.5 + 0.5 * cos(x * 3.0 * 6.2831);
          float capital = smoothstep(thisFloorH - 0.95, thisFloorH - 0.75, fv0) * (1.0 - smoothstep(thisFloorH - 0.1, thisFloorH, fv0));
          float shaft = step(1.2, fv0) * (1.0 - capital);
          color = stone * 1.05 * (1.0 - flute * 0.14 * shaft * (1.0 - smoothstep(0.01, 0.05, aa))) * (1.0 + capital * 0.07);
          rough = 0.85; metal = 0.0;
          n.x += (fract(x * 3.0) - 0.5) * 0.5 * shaft * sign(bu0 - bayW * 0.5);
        }
        color *= 1.0 - pilSide * 0.45;
        ao *= 1.0 - (1.0 - onPil) * 0.12 * (1.0 - smoothstep(0.0, 0.6, min(bu0, bayW - bu0) - pilW * 0.5));
      }
    }
  }
  if (style == 1.0) {
    // Curtain wall: spandrel bands between glass, subtle metal.
    float spandrel = 1.0 - glass;
    color = mix(color, tint * 0.75, spandrel * 0.6);
    rough = mix(rough, 0.45, spandrel); metal = mix(metal, 0.35, spandrel);
  }
  if (style == 3.0) {
    color = mix(color, tint * 0.95, 0.5);
  }
  // Ambient occlusion near the ground and under balconies.
  ao *= 1.0 - 0.25 * smoothstep(1.2, 0.0, v);

  f.color = color; f.rough = rough; f.metal = metal; f.emissive = emissive; f.ao = ao; f.n = n;
  return f;
}

// Roof surfaces: material from the baked id (meta.z: 0 zinc, 1 slate, 2 tile, 3 copper, 4 lead, 5 glass, 6 gilded, 7 painted);
// old chunks carry 0 everywhere and fall back to the tint heuristic. flag 5 = curved (dome / cone / vault): no
// dormers, meridian ribs instead of standing seams. uv = (metres along the eave, metres up the slope).
Facade shadeRoofSlope(vec2 uv, vec4 meta, vec3 tint, float flag, float night, float seedTime) {
  Facade f;
  float seed = mod(meta.w, 256.0);
  int mat = int(meta.z + 0.5);
  bool curved = flag > 4.5 && flag < 5.5;
  float aa = max(fwidth(uv.x), fwidth(uv.y)) * 0.75 + 0.002;
  float u = uv.x, s = uv.y;
  float texAmt = uHasFacadeTex;
  float lum = dot(tint, vec3(0.3333));
  bool slate = mat == 1 || (mat == 0 && tint.b > tint.r + 0.02 && lum < 0.45);
  bool tile = mat == 2 || (mat == 0 && tint.r > tint.b + 0.15);
  bool metalLike = false;
  vec3 color; float rough, metal; vec3 n = vec3(0.0, 0.0, 1.0);
  vec3 emissive = vec3(0.0);
  float seamW = curved ? 1.2 : 0.6;
  if (slate) {
    // Natural slate: photographic courses, matte blue-grey; the texture repeats every 2 m.
    vec2 tuv = (uv + vec2(seed * 0.7, 0.0)) / 2.0;
    vec3 sc = texAmt > 0.5 ? texture2D(uSlateC, tuv).rgb : vec3(0.22, 0.24, 0.28);
    color = sc * (0.85 + 0.15 * noise2(uv * 0.4 + seed)) * vec3(0.95, 0.98, 1.05);
    rough = texAmt > 0.5 ? mix(0.6, 0.95, texture2D(uSlateR, tuv).r) : 0.8;
    metal = 0.0;
    if (texAmt > 0.5) { n = texture2D(uSlateN, tuv).xyz * 2.0 - 1.0; n.xy *= 0.9; }
  } else if (tile) {
    // Terracotta tiles: procedural courses every 0.33 m with per-tile colour variation.
    float row = floor(s / 0.33), col = floor((u + mod(row, 2.0) * 0.12) / 0.24);
    float var = hash21(vec2(col, row) + seed);
    float edge = fract(s / 0.33);
    color = tint * (0.8 + 0.3 * var) * (1.0 - 0.25 * smoothstep(0.08, 0.0, edge));
    rough = 0.8; metal = 0.0;
    n = vec3(0.0, -0.3 * (1.0 - smoothstep(0.0, 0.08, edge)), 1.0);
  } else if (mat == 3) {
    // Copper gone green: verdigris with darker streaks running down the slope and a few brown patches.
    float streak = noise2(vec2(u * 2.2, s * 0.35) + seed);
    float patchy = smoothstep(0.62, 0.8, noise2(uv * 0.35 + seed * 2.1));
    color = mix(vec3(0.30, 0.55, 0.45), vec3(0.22, 0.42, 0.36), streak);
    color = mix(color, vec3(0.32, 0.22, 0.14), patchy * 0.6);
    rough = 0.55; metal = 0.25; metalLike = true;
  } else if (mat == 4) {
    // Lead: dull warm grey, matte, faint rolled joints.
    color = vec3(0.36, 0.36, 0.37) * (0.92 + 0.08 * noise2(uv * 0.7 + seed));
    rough = 0.9; metal = 0.15; metalLike = true;
  } else if (mat == 5) {
    // Glass roof (Grand Palais nave, station halls): dark blue-grey panes in an iron grid, lit from inside at night.
    float gx = 1.0 - smoothstep(0.0, aa * 2.0, abs(fract(u / 1.5) - 0.5) * 1.5 - 0.035);
    float gy = 1.0 - smoothstep(0.0, aa * 2.0, abs(fract(s / 2.4) - 0.5) * 2.4 - 0.035);
    float grid = max(gx, gy) * (1.0 - smoothstep(0.02, 0.1, aa));
    color = mix(vec3(0.10, 0.13, 0.17), vec3(0.16, 0.17, 0.18), grid);
    rough = mix(0.12, 0.6, grid); metal = mix(0.6, 0.4, grid);
    emissive = vec3(1.0, 0.85, 0.6) * 0.25 * night * (1.0 - grid);
  } else if (mat == 6) {
    // Gilded lead (Dôme des Invalides): warm gold with gilding wear along the ribs, glows under the floodlights.
    float wear = noise2(uv * 0.8 + seed) * 0.15;
    color = vec3(0.86, 0.66, 0.26) * (0.95 - wear);
    rough = 0.28; metal = 0.9; metalLike = true;
    emissive = color * 0.35 * night;
  } else if (mat == 7) {
    // Painted metal in the tagged colour, with the same seams as zinc.
    color = tint * (0.92 + 0.08 * noise2(uv * 0.9 + seed));
    rough = 0.5; metal = 0.35; metalLike = true;
  } else {
    // Zinc: soft patina and a little grain waviness.
    vec3 zinc = vec3(0.50, 0.53, 0.57) * (0.92 + 0.08 * noise2(uv * 0.9 + seed));
    zinc *= 0.94 + 0.10 * noise2(uv * 0.23 + seed * 1.7);
    color = zinc;
    rough = 0.42; metal = 0.55; metalLike = true;
    if (texAmt > 0.5) {
      vec2 guv = uv / 2.6;
      n = texture2D(uPlasterN, guv).xyz * 2.0 - 1.0; n.xy *= 0.25;
      rough += (texture2D(uWallR, guv).r - 0.5) * 0.25;
    }
  }
  if (metalLike) {
    // Standing seams every 0.6 m (meridian ribs every 1.2 m on domes) and panel joints every 2 m up the slope.
    float seam = 1.0 - smoothstep(0.0, aa * 2.0, abs(fract(u / seamW) - 0.5) * seamW - 0.02);
    color *= 1.0 - seam * 0.18 * (1.0 - smoothstep(0.01, 0.06, aa));
    float pj = 1.0 - smoothstep(0.0, aa * 2.0, abs(fract(s / 2.0) - 0.5) * 2.0 - 0.015);
    color *= 1.0 - pj * 0.12;
    n.x += seam * 0.35 * sign(fract(u / seamW) - 0.5);
  }
  if (!curved) {
    // Dormers on the steep first stage: one per ~3.2 m bay, 0.9 x 1.3 m window with a white frame.
    float bayW = 3.2;
    float bay = floor(u / bayW);
    float bu = u - bay * bayW;
    float has = step(0.35, ihash(uint(max(bay, 0.0)), uint(seed + 0.5)));
    float win = has * rectMask(vec2(bu, s), vec2(bayW * 0.5 - 0.5, 0.55), vec2(bayW * 0.5 + 0.5, 1.95), aa);
    float glass = has * rectMask(vec2(bu, s), vec2(bayW * 0.5 - 0.42, 0.63), vec2(bayW * 0.5 + 0.42, 1.87), aa);
    color = mix(color, vec3(0.9, 0.88, 0.84), win);
    color = mix(color, vec3(0.06, 0.07, 0.09), glass);
    rough = mix(rough, 0.2, glass);
    n.xy *= 1.0 - win;
  }
  f.color = color; f.rough = rough; f.metal = metal; f.emissive = emissive; f.ao = 1.0; f.n = normalize(n);
  return f;
}
