import type { Element as XmlElement, Node as XmlNode, Text as XmlText } from '@xmldom/xmldom'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

/** Confluence storage가 쓰는 네임스페이스 접두어(파싱 시 래퍼에 선언). */
const NAMESPACE_DECLS =
  'xmlns:ac="https://atlassian.com/ns" xmlns:ri="https://atlassian.com/resource-identifier"'
/**
 * Confluence storage는 HTML named entity(&nbsp; 등)를 포함할 수 있지만
 * XML 파서는 XML 5개(amp/lt/gt/quot/apos) 외 엔티티를 모른다.
 * 파싱 전에 흔한 named entity를 숫자 참조로 치환해 양쪽 동일하게 정규화한다.
 */
const NAMED_ENTITIES: Record<string, number> = {
  nbsp: 0xa0,
  copy: 0xa9,
  reg: 0xae,
  trade: 0x2122,
  hellip: 0x2026,
  mdash: 0x2014,
  ndash: 0x2013,
  lsquo: 0x2018,
  rsquo: 0x2019,
  ldquo: 0x201c,
  rdquo: 0x201d,
  laquo: 0xab,
  raquo: 0xbb,
  bull: 0x2022,
  dagger: 0x2020,
  times: 0xd7,
  divide: 0xf7,
  plusmn: 0xb1,
  deg: 0xb0,
  para: 0xb6,
  sect: 0xa7,
  middot: 0xb7,
  larr: 0x2190,
  rarr: 0x2192,
  uarr: 0x2191,
  darr: 0x2193,
  harr: 0x2194,
  frac12: 0xbd,
  euro: 0x20ac,
  pound: 0xa3,
  yen: 0xa5,
  cent: 0xa2,
  minus: 0x2212,
  ne: 0x2260,
  ge: 0x2265,
  le: 0x2264,
  isin: 0x2208,
  notin: 0x2209,
  sub: 0x2282,
  sup: 0x2283,
  ang: 0x2220,
  infin: 0x221e,
  sup1: 0xb9,
  sup2: 0xb2,
  sup3: 0xb3,
  asymp: 0x2248,
  equiv: 0x2261,
  alpha: 0x3b1,
  beta: 0x3b2,
  gamma: 0x3b3,
  delta: 0x3b4,
  pi: 0x3c0,
  mu: 0x3bc,
  sigma: 0x3c3,
  omega: 0x3c9,
  Delta: 0x394,
  Omega: 0x3a9,
  sum: 0x2211,
  prod: 0x220f,
  part: 0x2202,
  nabla: 0x2207,
  radic: 0x221a,
  int: 0x222b,
  Aring: 0xc5,
  agrave: 0xe0,
  eacute: 0xe9,
  egrave: 0xe8,
  // — 실제 스페이스 풀에서 파싱 실패가 관측된 엔티티(2026-09 E2E) —
  // zwj/zwnj/lrm/rlm은 이모지·한글 조합 및 bidi 제어에 쓰인다(누락 시 조합 깨짐).
  zwj: 0x200d,
  zwnj: 0x200c,
  lrm: 0x200e,
  rlm: 0x200f,
  there4: 0x2234,
  sube: 0x2286,
  supe: 0x2287,
  nsub: 0x2284,
  // 나머지 공통 HTML 엔티티(Confluence 편집기가 자주 삽입)
  iexcl: 0xa1,
  curren: 0xa4,
  brvbar: 0xa6,
  uml: 0xa8,
  ordf: 0xaa,
  not: 0xac,
  shy: 0xad,
  macr: 0xaf,
  acute: 0xb4,
  micro: 0xb5,
  cedil: 0xb8,
  ordm: 0xba,
  frac14: 0xbc,
  frac34: 0xbe,
  iquest: 0xbf,
  fnof: 0x192,
  circ: 0x2218,
  empty: 0x2205,
  alefsym: 0x2135,
  real: 0x211c,
  weierp: 0x2118,
  image: 0x2111,
  sim: 0x223c,
  simeq: 0x2243,
  cong: 0x2245,
  oplus: 0x2295,
  otimes: 0x2297,
  perp: 0x22a5,
  sdot: 0x22c5,
  lceil: 0x2308,
  rceil: 0x2309,
  lfloor: 0x230a,
  rfloor: 0x230b,
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
  sbquo: 0x201a,
  bdquo: 0x201e,
  Dagger: 0x2021,
  permil: 0x2030,
  lsaquo: 0x2039,
  rsaquo: 0x203a,
  oelig: 0x153,
  OElig: 0x152,
  Scaron: 0x160,
  scaron: 0x161,
  Yuml: 0x178,
  lArr: 0x21d0,
  uArr: 0x21d1,
  rArr: 0x21d2,
  dArr: 0x21d3,
  hArr: 0x21d4,
  crarr: 0x21b5,
  epsilon: 0x3b5,
  zeta: 0x3b6,
  eta: 0x3b7,
  theta: 0x3b8,
  kappa: 0x3ba,
  lambda: 0x3bb,
  xi: 0x3be,
  rho: 0x3c1,
  tau: 0x3c4,
  upsilon: 0x3c5,
  phi: 0x3c6,
  chi: 0x3c7,
  psi: 0x3c8,
  nu: 0x3bd,
  omicron: 0x3bf,
  Theta: 0x398,
  Lambda: 0x39b,
  Xi: 0x39e,
  Pi: 0x3a0,
  Sigma: 0x3a3,
  Phi: 0x3a6,
  Psi: 0x3a8,
}

function resolveNamedEntities(xml: string): string {
  // CDATA 내부는 리터럴 텍스트(코드 매크로 본문 등)이므로 엔티티로 해석하지 않는다.
  return xml
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g)
    .map((segment) => (segment.startsWith('<![CDATA[') ? segment : replaceNamedEntities(segment)))
    .join('')
}

function replaceNamedEntities(segment: string): string {
  return segment.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name: string) => {
    if (name === 'amp' || name === 'lt' || name === 'gt' || name === 'quot' || name === 'apos')
      return match
    const code = NAMED_ENTITIES[name]
    return code !== undefined ? `&#${code};` : match
  })
}

/**
 * storage 조각(fragment — 최상위 요소가 여러 개일 수 있음)을 DOM으로 파싱한다.
 * 단일 루트 요구를 피하려면 래퍼로 감싸 파싱한 뒤 자식들을 다룬다.
 */
export function parseStorageFragment(storageXml: string): XmlNode[] {
  const wrapped = `<__root ${NAMESPACE_DECLS}>${resolveNamedEntities(storageXml)}</__root>`
  const doc = new DOMParser().parseFromString(wrapped, 'text/xml')
  const root = doc.documentElement
  if (!root) throw new Error('storage XML 파싱 실패')
  return Array.from(root.childNodes) as XmlNode[]
}

/** 노드(들)를 storage XML 문자열로 되돌린다(xmldom 직렬화 — 내용 보존). */
function serializeNodes(nodes: XmlNode[]): string {
  const doc = new DOMParser().parseFromString(`<__root ${NAMESPACE_DECLS}></__root>`, 'text/xml')
  const root = doc.documentElement
  if (!root) throw new Error('XML 래퍼 파싱 실패')
  for (const node of nodes) {
    root.appendChild(doc.importNode(node, true))
  }
  const serialized = new XMLSerializer().serializeToString(root)
  return serialized.replace(/^<__root[^>]*>/, '').replace(/<\/__root>$/, '')
}

/** 단일 노드 직렬화(캐리어 해시 계산용). */
export function serializeNode(node: XmlNode): string {
  return serializeNodes([node])
}

export function localName(node: XmlNode): string {
  return node.nodeName.includes(':') ? node.nodeName.split(':')[1] : node.nodeName
}

export function isNamespaced(node: XmlNode): boolean {
  return node.nodeName.includes(':')
}

export function isElement(node: XmlNode): node is XmlElement {
  return node.nodeType === 1
}

export function isText(node: XmlNode): node is XmlText {
  return node.nodeType === 3
}

/** 텍스트 병합: 자식 텍스트를 이어 붙인다(테이블 셀 등 평가 전용 경로). */
export function textContent(node: XmlNode): string {
  return isText(node)
    ? (node.nodeValue ?? '')
    : Array.from(node.childNodes).map(textContent).join('')
}

/** storage 텍스트 노드 이스케이프(역변환 직렬화기용). */
export function escapeStorageText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeStorageAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
