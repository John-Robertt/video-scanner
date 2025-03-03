import { promises } from 'fs'
import { join, extname, parse } from 'path'
import { relative } from 'path'

// 复用原有的配置
const CONFIG = {
  targetDir: 'Z:/HC550-3/Download/output',
  maxDepth: 10,
  skipHiddenFiles: true,
  fileTypes: [
    '.mp4',
    '.avi',
    '.mkv',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.3gp',
  ],
  excludeDirs: ['node_modules', 'temp', 'downloads', '@eaDir'],
  // 添加NFO文件类型
  nfoFileType: '.nfo',
  // 添加要查找的特定封面链接
  targetCoverLink:
    '<cover>https://c0.jdbstatic.com/images/noimage_600x404.jpg</cover>',
  targetCoverLink2:
    '<cover>https://c0.jdbstatic.com/covers/qv/QVNO28.jpg</cover>',
}

// 存储扫描结果
const results = {
  multipleVideoFolders: [],
  // 添加存储包含特定封面链接的NFO文件夹
  noImageCoverFolders: [],
}

async function scanVideoFolders(dirPath, depth = 0) {
  if (depth > CONFIG.maxDepth) {
    console.warn(`🔴 超过最大递归深度 (${CONFIG.maxDepth}): ${dirPath}`)
    return
  }

  // 检查是否为排除目录
  const dirName = parse(dirPath).base
  if (CONFIG.excludeDirs.includes(dirName)) {
    return
  }

  try {
    const items = await promises.readdir(dirPath)
    const videoFiles = []
    const directories = []

    // 分离文件和目录
    for (const item of items) {
      if (CONFIG.skipHiddenFiles && item.startsWith('.')) continue

      const fullPath = join(dirPath, item)
      const stat = await promises.stat(fullPath)

      if (stat.isDirectory()) {
        directories.push(fullPath)
      } else if (
        stat.isFile() &&
        CONFIG.fileTypes.includes(extname(fullPath).toLowerCase())
      ) {
        videoFiles.push({ path: fullPath, name: item })
      }
    }

    // 如果当前目录包含多个视频文件，添加到结果中
    if (videoFiles.length > 1) {
      results.multipleVideoFolders.push({
        path: dirPath,
        videoCount: videoFiles.length,
        videos: videoFiles.map((f) => f.name),
      })
    }

    // 递归处理子目录
    await Promise.all(
      directories.map((dir) => scanVideoFolders(dir, depth + 1))
    )
  } catch (error) {
    console.error(`❌ 扫描目录失败: ${dirPath}`, error)
  }
}

// 添加扫描NFO文件的独立函数
async function scanNfoFiles(dirPath, depth = 0) {
  if (depth > CONFIG.maxDepth) {
    console.warn(`🔴 超过最大递归深度 (${CONFIG.maxDepth}): ${dirPath}`)
    return
  }

  // 检查是否为排除目录
  const dirName = parse(dirPath).base
  if (CONFIG.excludeDirs.includes(dirName)) {
    return
  }

  try {
    const items = await promises.readdir(dirPath)
    const nfoFiles = []
    const directories = []

    // 分离文件和目录
    for (const item of items) {
      if (CONFIG.skipHiddenFiles && item.startsWith('.')) continue

      const fullPath = join(dirPath, item)
      const stat = await promises.stat(fullPath)

      if (stat.isDirectory()) {
        directories.push(fullPath)
      } else if (
        stat.isFile() &&
        extname(fullPath).toLowerCase() === CONFIG.nfoFileType
      ) {
        nfoFiles.push({ path: fullPath, name: item })
      }
    }

    // 检查NFO文件是否包含目标封面链接
    if (nfoFiles.length > 0) {
      await checkNfoFilesForNoImageCover(dirPath, nfoFiles)
    }

    // 递归处理子目录
    await Promise.all(directories.map((dir) => scanNfoFiles(dir, depth + 1)))
  } catch (error) {
    console.error(`❌ 扫描目录失败: ${dirPath}`, error)
  }
}

// 检查NFO文件内容的函数
async function checkNfoFilesForNoImageCover(dirPath, nfoFiles) {
  for (const nfoFile of nfoFiles) {
    try {
      const content = await promises.readFile(nfoFile.path, 'utf-8')

      if (
        content.includes(CONFIG.targetCoverLink) ||
        content.includes(CONFIG.targetCoverLink2)
      ) {
        // 找到包含目标封面链接的NFO文件
        results.noImageCoverFolders.push({
          path: dirPath,
          nfoFile: nfoFile.name,
        })
        // 一个文件夹只需要记录一次，所以找到后就可以跳出循环
        break
      }
    } catch (error) {
      console.error(`❌ 读取NFO文件失败: ${nfoFile.path}`, error)
    }
  }
}

async function findMultipleVideoFolders() {
  console.log('📁 开始扫描包含多个视频文件的文件夹...\n')

  const startTime = Date.now()

  try {
    await scanVideoFolders(CONFIG.targetDir)

    // 输出结果
    console.log('\n📊 扫描结果')
    if (results.multipleVideoFolders.length === 0) {
      console.log('没有找到包含多个视频文件的文件夹')
    } else {
      console.log(
        `找到 ${results.multipleVideoFolders.length} 个包含多个视频文件的文件夹：\n`
      )
      results.multipleVideoFolders.forEach((folder) => {
        console.log(`📂 ${relative(CONFIG.targetDir, folder.path)}`)
        console.log(`   包含 ${folder.videoCount} 个视频文件：`)
        folder.videos.forEach((video) => console.log(`   - ${video}`))
        console.log()
      })
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`\n⏱️ 总耗时: ${duration} 秒`)
  } catch (error) {
    console.error('💥 程序执行出错:', error)
  }
}

// 添加查找包含无图片封面的NFO文件夹的独立函数
async function findNoImageCoverNfoFolders() {
  console.log('📁 开始扫描包含无图片封面的NFO文件夹...\n')

  const startTime = Date.now()

  try {
    await scanNfoFiles(CONFIG.targetDir)

    // 输出结果 - 包含无图片封面的NFO文件夹
    console.log('\n📊 扫描结果 - 包含无图片封面的NFO文件夹')
    if (results.noImageCoverFolders.length === 0) {
      console.log('没有找到包含无图片封面的NFO文件夹')
    } else {
      console.log(
        `找到 ${results.noImageCoverFolders.length} 个包含无图片封面的NFO文件夹：\n`
      )
      results.noImageCoverFolders.forEach((folder) => {
        console.log(`📂 ${relative(CONFIG.targetDir, folder.path)}`)
        console.log(`   包含无图片封面的NFO文件: ${folder.nfoFile}`)
        console.log()
      })
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`\n⏱️ 总耗时: ${duration} 秒`)
  } catch (error) {
    console.error('💥 程序执行出错:', error)
  }
}

// 如果需要同时执行两个功能，可以使用以下代码
async function runAllScans() {
  try {
    console.log('🔍 开始执行所有扫描任务...\n')

    // 清空之前的结果
    results.multipleVideoFolders = []
    results.noImageCoverFolders = []

    // 并行执行两个扫描任务
    await Promise.all([
      findMultipleVideoFolders(),
      findNoImageCoverNfoFolders(),
    ])

    console.log('\n✅ 所有扫描任务已完成')
  } catch (error) {
    console.error('💥 执行扫描任务时发生错误:', error)
    process.exit(1)
  }
}

findNoImageCoverNfoFolders()

// 取消注释下面的代码来执行所需的功能
// runAllScans()
