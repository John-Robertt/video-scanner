import EventEmitter from 'events'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { config } from './config.js'

export class Logger extends EventEmitter {
  constructor() {
    super()
    this.steps = new Map()
    this.logLevels = {
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
    }
    this.logFile = null
    this.writeStream = null
    this.initialized = false
    this.isWriting = false // 添加写入状态标记

    // 状态表情映射
    this.statusEmoji = {
      processing: '🔄',
      completed: '✅',
      failed: '❌',
    }

    // 日志级别颜色映射
    this.levelColors = {
      info: '\x1b[32m', // 绿色
      warn: '\x1b[33m', // 黄色
      error: '\x1b[31m', // 红色
    }
    this.resetColor = '\x1b[0m'
  }

  /**
   * 开始一个新的处理步骤
   * @param {string} taskId 任务ID
   * @param {string} step 步骤名称
   * @param {string} message 步骤描述
   */
  startStep(taskId, step, message) {
    const stepInfo = {
      step,
      message,
      status: 'processing',
      startTime: new Date(),
      endTime: null,
      level: this.logLevels.INFO,
    }

    if (!this.steps.has(taskId)) {
      this.steps.set(taskId, new Map())
    }

    this.steps.get(taskId).set(step, stepInfo)
    this.emit('stepUpdate', { taskId, ...stepInfo })
  }

  /**
   * 完成一个处理步骤
   * @param {string} taskId 任务ID
   * @param {string} step 步骤名称
   * @param {string} message 完成消息
   */
  completeStep(taskId, step, message) {
    const taskSteps = this.steps.get(taskId)
    if (!taskSteps) {
      // 如果任务不存在，创建新的任务记录
      this.steps.set(taskId, new Map())
      const stepInfo = {
        step,
        message: message,
        status: 'completed',
        startTime: new Date(),
        endTime: new Date(),
        duration: 0,
        level: this.logLevels.INFO,
      }
      this.steps.get(taskId).set(step, stepInfo)
      this.emit('stepUpdate', { taskId, ...stepInfo })
      return
    }

    if (taskSteps.has(step)) {
      const stepInfo = taskSteps.get(step)
      stepInfo.duration = new Date() - stepInfo.startTime
      stepInfo.status = 'completed'
      stepInfo.endTime = new Date()
      stepInfo.message = message || stepInfo.message
      this.emit('stepUpdate', { taskId, ...stepInfo })
    } else {
      // 如果步骤不存在，创建新的步骤记录
      const stepInfo = {
        step,
        message: message,
        status: 'completed',
        startTime: new Date(),
        endTime: new Date(),
        duration: 0,
        level: this.logLevels.INFO,
      }
      taskSteps.set(step, stepInfo)
      this.emit('stepUpdate', { taskId, ...stepInfo })
    }
  }

  /**
   * 标记步骤失败
   * @param {string} taskId 任务ID
   * @param {string} step 步骤名称
   * @param {string} error 错误信息
   */
  failStep(taskId, step, error) {
    const taskSteps = this.steps.get(taskId)
    if (!taskSteps) {
      // 如果任务不存在，创建新的任务记录
      this.steps.set(taskId, new Map())
      const stepInfo = {
        step,
        message: error,
        status: 'failed',
        startTime: new Date(),
        endTime: new Date(),
        error,
        level: this.logLevels.ERROR,
      }
      this.steps.get(taskId).set(step, stepInfo)
      this.emit('stepUpdate', { taskId, ...stepInfo })
      return
    }

    if (taskSteps.has(step)) {
      const stepInfo = taskSteps.get(step)
      stepInfo.status = 'failed'
      stepInfo.endTime = new Date()
      stepInfo.error = error
      stepInfo.level = this.logLevels.ERROR
      this.emit('stepUpdate', { taskId, ...stepInfo })
    } else {
      // 如果步骤不存在，创建新的步骤记录
      const stepInfo = {
        step,
        message: error,
        status: 'failed',
        startTime: new Date(),
        endTime: new Date(),
        error,
        level: this.logLevels.ERROR,
      }
      taskSteps.set(step, stepInfo)
      this.emit('stepUpdate', { taskId, ...stepInfo })
    }
  }

  /**
   * 初始化日志文件
   */
  async initLogFile() {
    // 避免重复初始化
    if (this.initialized) {
      return
    }

    if (!config.get('log.enabled')) return

    // 获取配置
    const logPath = config.get('log.path', 'log')
    const logFilename = config.get('log.filename', 'app.log')
    const maxSize = config.get('log.maxSize', 10 * 1024 * 1024)

    // 统一日志目录路径处理
    // 如果 logPath 是绝对路径，则直接使用；否则，相对于 outputDir 的父目录
    let logDir
    if (path.isAbsolute(logPath)) {
      logDir = logPath
    } else {
      const outputDir = config.get('base.outputDir')
      // 使用 outputDir 的父目录作为基准
      const baseDir = path.dirname(outputDir)
      logDir = path.join(baseDir, logPath)
    }

    // 确保日志目录存在
    try {
      await fs.mkdir(logDir, { recursive: true })
    } catch (error) {
      console.error(`创建日志目录失败: ${error.message}`)
      return
    }

    this.logFile = path.join(logDir, logFilename)

    // 检查文件大小并进行轮转
    try {
      const stats = await fs.stat(this.logFile)
      if (stats.size > maxSize) {
        const backupFile = `${this.logFile}.${new Date().getTime()}.bak`
        await fs.rename(this.logFile, backupFile)
      }
    } catch (error) {
      // 文件不存在，直接创建新文件
    }

    // 使用正确导入的 createWriteStream
    this.writeStream = createWriteStream(this.logFile, { flags: 'a' })

    // 记录日志初始化信息
    const timestamp = new Date().toISOString()
    this.writeStream.write(
      `${timestamp} 日志系统初始化，日志文件路径: ${this.logFile}\n`
    )

    this.initialized = true
  }

  async writeToFile(message) {
    // 如果已经在写入或者流不可用，直接返回
    if (this.isWriting || !this.writeStream || !config.get('log.enabled')) {
      return
    }

    this.isWriting = true
    try {
      const timestamp = new Date().toISOString()
      const logEntry = `${timestamp} ${message}\n`

      // 使用 Promise 包装 write 操作
      await new Promise((resolve, reject) => {
        this.writeStream.write(logEntry, (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    } catch (error) {
      // 写入失败时只打印到控制台，不再触发新的日志写入
      console.error('\x1b[31m%s\x1b[0m', '写入日志文件失败:', error.message)
    } finally {
      this.isWriting = false
    }
  }

  // 添加关闭方法
  async close() {
    if (this.writeStream) {
      return new Promise((resolve) => {
        this.writeStream.end(() => {
          this.writeStream = null
          resolve()
        })
      })
    }
  }

  /**
   * 清理旧的日志文件
   */
  async cleanupOldLogs() {
    try {
      if (!this.logFile) {
        return
      }

      const logDir = path.dirname(this.logFile)
      const maxBackups = config.get('log.maxBackups') || 5

      // 确保日志目录存在
      try {
        await fs.access(logDir)
      } catch (error) {
        // 日志目录不存在，无需清理
        return
      }

      const files = await fs.readdir(logDir)

      const backupFiles = files
        .filter(
          (file) =>
            file.startsWith(path.basename(this.logFile)) &&
            file.endsWith('.bak')
        )
        .map((file) => ({
          name: file,
          path: path.join(logDir, file),
          time: parseInt(file.split('.').slice(-2)[0]),
        }))

      // 按时间排序，保留最新的 maxBackups 个备份
      if (backupFiles.length > maxBackups) {
        const filesToDelete = backupFiles
          .sort((a, b) => b.time - a.time)
          .slice(maxBackups)

        for (const file of filesToDelete) {
          try {
            await fs.unlink(file.path)
          } catch (error) {
            console.warn(`删除旧日志文件失败: ${file.path}`, error)
          }
        }
      }
    } catch (error) {
      console.error('清理旧日志文件失败:', error)
    }
  }

  /**
   * 格式化日志消息
   * @private
   */
  _formatLogMessage(stepInfo) {
    const { taskId, step, status, message, error, startTime, duration, level } =
      stepInfo

    // 格式化时间
    const time = new Date(startTime).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    })

    // 构建输出消息
    let logMessage = `[${time}] ${this.statusEmoji[status]} [${taskId}] ${step}: ${message}`

    // 添加持续时间（如果有）
    if (duration) {
      logMessage += ` (耗时: ${duration}ms)`
    }

    // 添加错误信息（如果有）
    if (error) {
      logMessage += `\n  错误: ${error}`
    }

    // 添加颜色
    return `${this.levelColors[level] || ''}${logMessage}${this.resetColor}`
  }

  emit(event, stepInfo) {
    if (event === 'stepUpdate') {
      // 格式化并输出到控制台
      const formattedMessage = this._formatLogMessage(stepInfo)
      console.log(formattedMessage)

      // 如果不是错误日志写入失败的消息，才写入文件
      if (!this.isWriting) {
        // 写入日志文件（不包含颜色代码）
        const plainMessage = this._formatLogMessage(stepInfo).replace(
          new RegExp('\u001b' + '\\[\\d+m', 'g'),
          ''
        ) // 移除颜色代码
        this.writeToFile(plainMessage)
      }
    }

    // 调用父类的 emit 方法
    super.emit(event, stepInfo)
  }
}

export const logger = new Logger()
