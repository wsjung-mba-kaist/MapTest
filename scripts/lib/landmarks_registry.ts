import type { LandmarkCategory } from '../../shared/layout.ts';

/**
 * Curated landmarks inside the baked square. Positions, names, descriptions and photos are resolved at bake time
 * (OSM centre -> Wikidata -> Wikipedia summary -> Commons file); `approx` is the last-resort position so an entry
 * never disappears when a service is down. `view` is where the camera lands (keys 1-8 keep the historical spots).
 */
export interface LandmarkSpec {
  id: string;
  osm?: `node/${number}` | `way/${number}` | `relation/${number}`;
  /** overrides the OSM `wikidata` tag */
  wikidata?: string;
  category: LandmarkCategory;
  hotkey?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  hidden?: boolean;
  /** world x/z fallback */
  approx: [number, number];
  /** landing spot; yaw in degrees, deck = tower floor index (1 = 2nd floor) */
  view?: { x: number; z: number; yaw?: number; deck?: number };
  /** what the camera faces on arrival when `view.yaw` is not given */
  face?: 'tower' | 'centre';
  radius: number;
  short: string;
  blurbKo?: string;
}

export const LANDMARKS: LandmarkSpec[] = [
  { id: 'trocadero', osm: 'node/1697202142', category: 'square', hotkey: 1, approx: [-424, -393], view: { x: -480, z: -409 }, face: 'tower', radius: 90, short: '트로카데로',
    blurbKo: '샤요 궁 두 날개 사이의 인권 광장. 에펠탑을 정면으로 마주 보는 파리 최고의 전망대다.' },
  { id: 'pont-iena', osm: 'way/184263889', category: 'bridge', hotkey: 2, approx: [-177, -160], view: { x: -190, z: -200 }, face: 'tower', radius: 90, short: '이에나 다리',
    blurbKo: '트로카데로와 에펠탑을 잇는 1814년의 석조 아치교. 양쪽 끝을 네 기의 기마상이 지킨다.' },
  { id: 'eiffel', osm: 'way/5013364', category: 'monument', hotkey: 3, approx: [1, 8], view: { x: 0, z: 70 }, face: 'tower', radius: 110, short: '에펠탑',
    blurbKo: '1889년 만국박람회를 위해 귀스타브 에펠이 세운 높이 330 m의 철탑. 파리의 상징이다.' },
  { id: 'champ-de-mars', wikidata: 'Q217925', category: 'park', hotkey: 4, approx: [302, 308], view: { x: 290, z: 380 }, face: 'tower', radius: 220, short: '샹드마르스',
    blurbKo: '에펠탑에서 에콜 밀리테르까지 780 m 이어지는 공원. 만국박람회와 혁명 축제의 무대였다.' },
  { id: 'ecole-militaire', osm: 'way/106312008', category: 'military', hotkey: 5, approx: [761, 725], view: { x: 600, z: 760 }, radius: 150, short: '에콜 밀리테르',
    blurbKo: '루이 15세가 세운 사관학교(1760). 나폴레옹이 이곳에서 포병 장교로 임관했다.' },
  { id: 'pont-bir-hakeim', osm: 'way/183602168', category: 'bridge', hotkey: 6, approx: [-506, 300], view: { x: -540, z: 380 }, face: 'tower', radius: 120, short: '비르아켐 다리',
    blurbKo: '위층으로 6호선 지하철이 지나는 2층 철교(1905). 영화 촬영지로도 유명하다.' },
  { id: 'quai-branly', wikidata: 'Q167863', category: 'museum', hotkey: 7, approx: [236, -281], view: { x: 260, z: -80 }, radius: 120, short: '케 브랑리 박물관',
    blurbKo: '장 누벨이 설계한 비유럽권 예술 박물관(2006). 센강 쪽 유리 벽과 수직 정원이 특징이다.' },
  { id: 'eiffel-deck', osm: 'way/5013364', category: 'monument', hotkey: 8, hidden: true, approx: [1, 8], view: { x: -42, z: -30, deck: 1 }, radius: 0, short: '에펠탑 2층',
    blurbKo: '지상 115 m의 2층 전망대. 트로카데로와 센강, 파리 서쪽이 한눈에 들어온다.' },

  { id: 'chaillot', osm: 'relation/6826569', category: 'palace', approx: [-412, -389], radius: 150, short: '샤요 궁',
    blurbKo: '1937년 만국박람회를 위해 지은 신고전주의 궁전. 곡선을 그리는 두 날개에 박물관과 극장이 들어 있다.' },
  { id: 'musee-homme', osm: 'node/3787532339', category: 'museum', approx: [-505, -404], radius: 50, short: '인류박물관' },
  { id: 'cite-architecture', osm: 'node/1296750671', category: 'museum', approx: [-402, -504], radius: 50, short: '건축·문화유산 도시' },
  { id: 'musee-marine', osm: 'node/1296754169', category: 'museum', approx: [-527, -381], radius: 50, short: '해양박물관' },
  { id: 'trocadero-gardens', wikidata: 'Q1683459', category: 'park', approx: [-300, -300], face: 'tower', radius: 120, short: '트로카데로 정원',
    blurbKo: '샤요 궁에서 센강까지 내려오는 정원. 바르샤바 분수의 물대포가 에펠탑을 향해 뿜어진다.' },
  { id: 'palais-tokyo', osm: 'way/79219351', category: 'museum', approx: [142, -638], radius: 90, short: '팔레 드 도쿄',
    blurbKo: '1937년 만국박람회의 근대미술관. 동관은 파리시립근대미술관, 서관은 현대미술 센터다.' },
  { id: 'galliera', osm: 'relation/1191057', category: 'museum', approx: [160, -816], radius: 70, short: '갈리에라 궁' },
  { id: 'guimet', osm: 'way/79641993', category: 'museum', approx: [-68, -781], radius: 60, short: '기메 박물관' },
  { id: 'pont-alma', osm: 'way/183589443', wikidata: 'Q1621256', category: 'bridge', approx: [534, -566], face: 'tower', radius: 70, short: '알마 다리',
    blurbKo: '센강의 수위를 재는 잣대로 쓰이는 주아브 병사 석상이 서 있는 다리.' },
  { id: 'flamme-liberte', osm: 'way/92316094', category: 'monument', approx: [469, -647], radius: 40, short: '자유의 불꽃',
    blurbKo: '자유의 여신상 횃불의 실물 크기 복제품(1989). 알마 지하차도 위에 있어 다이애나 비 추모의 장소가 되었다.' },
  { id: 'pont-invalides', osm: 'way/183618971', category: 'bridge', approx: [1167, -579], radius: 70, short: '앵발리드 다리' },
  { id: 'pont-alexandre-iii', osm: 'way/183620685', category: 'bridge', approx: [1399, -588], radius: 90, short: '알렉상드르 3세 다리',
    blurbKo: '1900년 만국박람회를 위해 지은 파리에서 가장 화려한 다리. 네 기둥 위에 금빛 페가수스가 서 있다.' },
  { id: 'grand-palais', osm: 'way/56185523', category: 'museum', approx: [1305, -865], radius: 140, short: '그랑 팔레',
    blurbKo: '1900년 만국박람회의 전시관. 유리와 철로 된 거대한 둥근 천장이 유명하다.' },
  { id: 'petit-palais', osm: 'relation/2778854', category: 'museum', approx: [1503, -854], radius: 90, short: '프티 팔레' },
  { id: 'invalides', osm: 'relation/1463538', category: 'monument', approx: [1326, 269], radius: 220, short: '앵발리드',
    blurbKo: '루이 14세가 상이군인을 위해 세운 건물군(1671~). 황금 돔 아래에 나폴레옹의 묘가 있다.' },
  { id: 'dome-invalides', wikidata: 'Q152109', category: 'church', approx: [1322, 375], radius: 60, short: '앵발리드 돔',
    blurbKo: '높이 107 m의 황금 돔 성당(1706). 나폴레옹 1세의 관이 안치되어 있다.' },
  { id: 'saint-louis-invalides', osm: 'way/64955027', category: 'church', approx: [1328, 304], radius: 50, short: '생루이 데 앵발리드 성당' },
  { id: 'musee-armee', osm: 'node/130102845', category: 'museum', approx: [1278, 152], radius: 60, short: '군사박물관' },
  { id: 'statue-liberte', osm: 'node/465294103', category: 'monument', approx: [-1085, 928], radius: 50, short: '자유의 여신상',
    blurbKo: '백조의 섬 끝에 선 뉴욕 자유의 여신상의 1/4 크기 복제품(1889). 서쪽 뉴욕을 바라본다.' },
  { id: 'saint-pierre-chaillot', osm: 'way/79276832', category: 'church', approx: [294, -1037], radius: 60, short: '생피에르 드 샤요 교회' },
  { id: 'eglise-americaine', osm: 'way/69049385', category: 'church', approx: [911, -417], radius: 40, short: '아메리칸 교회' },
  { id: 'theatre-champs-elysees', osm: 'way/69486335', category: 'theatre', approx: [610, -837], radius: 50, short: '샹젤리제 극장',
    blurbKo: '오귀스트 페레의 초기 철근콘크리트 건축(1913). 스트라빈스키 「봄의 제전」이 초연된 곳이다.' },
  { id: 'unesco', wikidata: 'Q3279650', category: 'institution', approx: [845, 964], radius: 120, short: '유네스코 본부',
    blurbKo: 'Y자형 본부 건물(1958). 브로이어·네르비·제르퓌스가 설계했다.' },
  { id: 'radio-france', wikidata: 'Q579087', category: 'institution', approx: [-1136, 664], radius: 120, short: '라디오 프랑스',
    blurbKo: '센강변의 원형 방송국 건물(1963). 중앙에 높이 68 m의 탑이 솟아 있다.' },
  { id: 'mur-paix', wikidata: 'Q3327987', category: 'monument', approx: [625, 686], radius: 40, short: '평화의 벽',
    blurbKo: '49개 언어로 「평화」를 새긴 유리 벽(2000). 예루살렘 통곡의 벽에서 착안했다.' },
];
