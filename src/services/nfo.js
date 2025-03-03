// 处理 NFO 文件的生成和解析
import fs from 'fs/promises'

export class Nfo {
  /**
   * 生成NFO文件
   * @param {Object} metadata 视频元数据
   * @param {string} outputPath 输出路径
   */
  async generateNfo(metadata, outputPath) {
    const escapeXML = (str) => {
      if (!str) return ''
      return str.replace(/[<>&'"]/g, (char) => {
        switch (char) {
          case '<':
            return '&lt;'
          case '>':
            return '&gt;'
          case '&':
            return '&amp;'
          case "'":
            return '&apos;'
          case '"':
            return '&quot;'
          default:
            return char
        }
      })
    }

    let nfoContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${escapeXML(metadata.title)}</title>
  <sorttitle>${escapeXML(metadata.code || '')}</sorttitle>
  <num>${escapeXML(metadata.code || '')}</num>
  <studio>${escapeXML(metadata.maker || '')}</studio>
  <release>${escapeXML(metadata.releaseDate || '')}</release>
  <premiered>${escapeXML(metadata.releaseDate || '')}</premiered>
  <year>${escapeXML(metadata.releaseDate?.substring(0, 4) || '')}</year>
  <runtime>${escapeXML(metadata.duration?.replace(/[^0-9]/g, '') || '')}</runtime>
  <mpaa>R18+</mpaa>
  <country>JP</country>
  <poster>poster.jpg</poster>
  <thumb>poster.jpg</thumb>
  <fanart>fanart.jpg</fanart>
${metadata.ratingValue ? `  <rating>${escapeXML(metadata.ratingValue)}</rating>` : ''}
${metadata.ratingValue ? `  <userrating>${escapeXML(metadata.ratingValue)}</userrating>` : ''}
${metadata.ratingVotes ? `  <votes>${escapeXML(metadata.ratingVotes)}</votes>` : ''}
${(metadata.actors || [])
  .map(
    (actor) => `  <actor>
    <name>${escapeXML(actor)}</name>
    <role>${escapeXML(actor)}</role>
  </actor>`
  )
  .join('\n')}
${(metadata.categories || [])
  .map((category) => `  <tag>${escapeXML(category)}</tag>`)
  .join('\n')}
${(metadata.categories || [])
  .map((category) => `  <genre>${escapeXML(category)}</genre>`)
  .join('\n')}
  <set>${escapeXML(metadata.series || '')}</set>
  <cover>${escapeXML(metadata.coverUrl || '')}</cover>
  <website>${escapeXML(metadata.detailUrl || '')}</website>
</movie>`

    // 清理空行
    nfoContent = nfoContent
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n')

    await fs.writeFile(outputPath, nfoContent, 'utf8')
  }
}

export const nfo = new Nfo()
