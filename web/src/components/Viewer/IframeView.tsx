// tick forces the iframe to reload (cache-bust) when the underlying file may have changed
// on disk (e.g. at the end of a WS turn) — the URL alone would stay identical otherwise.
export default function IframeView({ src, tick }: { src: string; tick?: number }) {
  const bustedSrc = tick ? `${src}${src.includes("?") ? "&" : "?"}_r=${tick}` : src;
  return <iframe src={bustedSrc} title="document preview" />;
}
