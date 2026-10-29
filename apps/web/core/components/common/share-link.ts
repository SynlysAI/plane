/**
 * 将应用内相对链接转换为可在外部沟通工具中打开的绝对链接。
 *
 * Args:
 *   href: 应用路由或完整链接。
 *   origin: 用于解析相对链接的站点来源。
 *
 * Returns:
 *   可直接分享的绝对链接。
 */
export function absoluteShareUrl(href: string, origin = window.location.origin): string {
  return new URL(href, origin).href;
}

/**
 * 构造带对象类型与标题上下文的统一分享文本。
 *
 * Args:
 *   typeLabel: 已本地化的对象类型，例如“行政工作项”“周报”。
 *   title: 分享对象标题。
 *   href: 应用路由或完整链接。
 *
 * Returns:
 *   “OpenEVA 类型: 标题 ( 链接 )”格式的分享文本。
 */
export function formatShareText(typeLabel: string, title: string, href: string): string {
  return `OpenEVA ${typeLabel}: ${title} ( ${absoluteShareUrl(href)} )`;
}
