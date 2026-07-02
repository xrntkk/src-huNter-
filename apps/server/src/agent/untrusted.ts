/**
 * 不可信数据隔离 —— 防御 prompt injection。
 *
 * 目标网站的 HTTP 响应体、报错信息、搜索结果、页面文本等都是**攻击者可控**的，
 * 会被原样喂回模型，是典型的 prompt injection 入口。本模块把这类文本用一个
 * 每次随机生成的 nonce 包裹起来：
 *
 *   <untrusted_data id="a3f9..."> ...内容... </untrusted_data id="a3f9...">
 *
 * 由于 nonce 在内容写入之后才生成，内容无法预先伪造出匹配的闭合标签；
 * sanitize 额外中和任何看起来像闭合标签的串，使内容连「提前结束」都做不到。
 * 配合系统 prompt 的说明，模型知道块内只是数据、绝不当作指令执行。
 *
 * 借鉴自 Anthropic defending-code-reference-harness 的 untrusted.py。
 */
import { randomBytes } from 'node:crypto'

const CLOSING_TAG = /<\/\s*untrusted_data/gi

/** 每次包裹用的随机分隔符 id。 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex')
}

/** 中和任何可能提前闭合 <untrusted_data> 块的串。 */
export function sanitizeUntrusted(text: string): string {
  return text.replace(CLOSING_TAG, '<untrusted_data')
}

/** 用 nonce 分隔标签包裹攻击者可控文本。 */
export function untrustedBlock(text: string, nonce: string = makeNonce()): string {
  return (
    `<untrusted_data id="${nonce}">\n` +
    `${sanitizeUntrusted(text)}\n` +
    `</untrusted_data id="${nonce}">`
  )
}
