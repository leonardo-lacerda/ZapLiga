// O SVG usa `var(--cor)` (tokens do tema) em `stroke`/`fill`. Um clone
// serializado e carregado isolado numa <img> não tem acesso ao CSS da
// página, então essas variáveis nunca resolveriam — ficaria preto/tudo
// igual. `getComputedStyle` no elemento ORIGINAL (ainda no DOM) já devolve
// a cor final resolvida; gravamos isso como atributo explícito no clone
// antes de serializar, tornando-o autocontido.
function inlineComputedPaint(original: Element, clone: Element) {
  const computed = window.getComputedStyle(original);
  if (computed.fill && computed.fill !== 'none') clone.setAttribute('fill', computed.fill);
  if (computed.stroke && computed.stroke !== 'none') clone.setAttribute('stroke', computed.stroke);
  const originalChildren = Array.from(original.children);
  const cloneChildren = Array.from(clone.children);
  originalChildren.forEach((child, index) => { if (cloneChildren[index]) inlineComputedPaint(child, cloneChildren[index]); });
}

/**
 * Exporta um <svg> do gráfico como PNG (plano seção 6.8: "exportação de
 * gráficos como imagem"). Feito no cliente — o SVG já existe no DOM, então
 * não há razão para ida e volta ao backend só para rasterizar uma imagem.
 */
export function downloadSvgAsPng(svg: SVGSVGElement, fileName: string) {
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox && viewBox.width ? viewBox.width : svg.clientWidth || 640;
  const height = viewBox && viewBox.height ? viewBox.height : svg.clientHeight || 320;
  const scale = 2; // exporta em alta resolução para caber bem em slides/documentos

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedPaint(svg, clone);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const svgString = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));

  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    URL.revokeObjectURL(svgUrl);
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const pngUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = pngUrl; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  };
  image.src = svgUrl;
}
