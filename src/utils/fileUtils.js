// 文件操作工具
import { promises, constants } from 'fs'
import { join, parse, dirname } from 'path'
import trash from 'trash'

export class FileUtils {
  /**
   * 移动文件到指定目录
   * @param {string} sourcePath - 源文件路径
   * @param {string} targetDir - 目标目录
   * @param {Object} options - 配置选项
   * @param {boolean} [options.useSafeDelete=true] - 是否使用安全删除（移动到回收站）
   * @param {boolean} [options.overwrite=false] - 是否覆盖已存在的文件
   * @param {boolean} [options.createDir=true] - 是否自动创建目标目录
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  async moveFile(sourcePath, targetDir, options = {}) {
    const {
      useSafeDelete = true,
      overwrite = false,
      createDir = true,
    } = options

    try {
      // 检查源文件是否存在
      try {
        await promises.access(sourcePath, constants.R_OK)
      } catch (error) {
        return {
          success: false,
          error: `源文件不存在或无法访问: ${error.message}`,
        }
      }

      // 创建目标目录（如果不存在且需要创建）
      if (createDir) {
        try {
          await promises.mkdir(targetDir, { recursive: true })
        } catch (error) {
          if (error.code !== 'EEXIST') {
            return {
              success: false,
              error: `创建目标目录失败: ${error.message}`,
            }
          }
        }
      } else {
        // 检查目标目录是否存在
        try {
          await promises.access(targetDir, constants.W_OK)
        } catch (error) {
          return {
            success: false,
            error: `目标目录不存在或无法写入: ${error.message}`,
          }
        }
      }

      const { base: fileName } = parse(sourcePath)
      let targetPath = join(targetDir, fileName)

      // 如果目标文件已存在且不覆盖
      if (!overwrite) {
        const { ext, name } = parse(fileName)
        let counter = 1

        while (await this.fileExists(targetPath)) {
          targetPath = join(targetDir, `${name} (${counter})${ext}`)
          counter++
        }
      } else if (await this.fileExists(targetPath)) {
        // 如果目标文件存在且需要覆盖，先检查是否可写
        try {
          await promises.access(targetPath, constants.W_OK)
        } catch (error) {
          return {
            success: false,
            error: `目标文件存在但无法覆盖: ${error.message}`,
          }
        }
      }

      // 检查是否为跨设备移动
      try {
        const sourceStats = await promises.stat(sourcePath)
        const targetStats = await promises.stat(dirname(targetPath))

        if (sourceStats.dev !== targetStats.dev) {
          // 跨设备移动：先复制后删除
          await promises.copyFile(sourcePath, targetPath)

          if (useSafeDelete) {
            await trash(sourcePath)
          } else {
            await promises.unlink(sourcePath)
          }
        } else {
          // 同设备移动：直接重命名
          await promises.rename(sourcePath, targetPath)
        }
      } catch (error) {
        return {
          success: false,
          error: `移动文件失败: ${error.message}`,
        }
      }

      return {
        success: true,
        path: targetPath,
      }
    } catch (error) {
      console.error(`移动文件时发生未预期的错误: ${error.message}`)
      return {
        success: false,
        error: error.message,
      }
    }
  }

  /**
   * 检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>}
   */
  async fileExists(filePath) {
    try {
      await promises.access(filePath)
      return true
    } catch {
      return false
    }
  }
}

export const fileUtils = new FileUtils()
