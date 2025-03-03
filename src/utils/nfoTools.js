import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { logger } from '../services/logger.js'

/**
 * 清理 NFO 文件中的空白行
 * @param {string} filePath - NFO 文件路径
 */
const cleanNfoFile = (filePath) => {
  try {
    // 读取文件内容
    const content = readFileSync(filePath, 'utf8')

    // // 替换 MPAA 评级
    // processedContent = processedContent.replace(
    //   /<mpaa>NC-17<\/mpaa>/i,
    //   '<mpaa>R18+</mpaa>'
    // )

    // 再移除空白行，保留有内容的行
    const cleanedContent = content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .join('\n')

    // 写回文件
    writeFileSync(filePath, cleanedContent)
    logger.startStep('nfo', 'clean', `已清理文件: ${filePath}`)
  } catch (error) {
    logger.failStep(
      'nfo',
      'clean',
      `处理文件 ${filePath} 时出错: ${error.message}`
    )
  }
}

/**
 * 查找并处理目录中的所有 NFO 文件
 * @param {string} dirPath - 要搜索的目录路径
 */
const processNfoFiles = (dirPath) => {
  try {
    // 读取目录内容
    const files = readdirSync(dirPath)

    // 遍历所有文件
    files.forEach((file) => {
      const fullPath = join(dirPath, file)

      if (statSync(fullPath).isDirectory()) {
        // 如果是目录，递归处理
        processNfoFiles(fullPath)
      } else if (extname(file).toLowerCase() === '.nfo') {
        // 如果是 NFO 文件，进行处理
        cleanNfoFile(fullPath)
      }
    })
  } catch (error) {
    logger.failStep(
      'nfo',
      'process',
      `处理目录 ${dirPath} 时出错: ${error.message}`
    )
  }
}

export default {
  cleanNfoFile,
  processNfoFiles,
}
