import * as fs from 'fs'
import * as exec from '@actions/exec'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as io from '@actions/io'
import {PiGenStages} from './pi-gen-stages'
import {PiGenConfig, writeToFile} from './pi-gen-config'
import path from 'path'

export class PiGen {
  private configFilePath: string
  private piGenBuildLogPattern = new RegExp(
    '^\\s*\\[(?:\\d{2}:?){3}\\].*',
    'gm'
  )

  constructor(private piGenDirectory: string, private config: PiGenConfig) {
    if (!this.validatePigenDirectory()) {
      throw new Error(`pi-gen directory at ${this.piGenDirectory} is invalid`)
    }

    this.configFilePath = `${fs.realpathSync(this.piGenDirectory)}/config`
  }

  async build(verbose = false): Promise<exec.ExecOutput> {
    core.debug(`Writing user config to ${this.configFilePath}`)
    await writeToFile(this.config, this.piGenDirectory, this.configFilePath)

    await this.configureImageExports()

    const dockerOpts = this.getStagesAsDockerMounts()
    core.debug(
      `Running pi-gen build with PIGEN_DOCKER_OPTS="${dockerOpts}" and config: ${JSON.stringify(
        this.config
      )}`
    )

    return await exec.getExecOutput(
      '"./build-docker.sh"',
      ['-c', this.configFilePath],
      {
        cwd: this.piGenDirectory,
        env: {
          PIGEN_DOCKER_OPTS: dockerOpts
        },
        listeners: {
          stdline: (line: string) => this.logOutput(line, verbose, 'info'),
          errline: (line: string) => this.logOutput(line, verbose, 'warning')
        },
        silent: true
      }
    )
  }

  async getLastImagePath(): Promise<string | undefined> {
    const imageExtension =
      this.config.deployCompression === 'none'
        ? 'img'
        : this.config.deployCompression
    const imageGlob = await glob.create(
      `${this.piGenDirectory}/deploy/*.${imageExtension}`,
      {matchDirectories: false}
    )
    const foundImages = await imageGlob.glob()
    return foundImages.length > 0 ? foundImages[0] : undefined
  }

  async getLastNoobsImagePath(): Promise<string | undefined> {
    const imageGlob = await glob.create(
      `${this.piGenDirectory}/deploy/${this.config.imgName}-`,
      {matchDirectories: true}
    )
    const foundImages = await imageGlob.glob()
    return foundImages.length > 0 ? foundImages[0] : undefined
  }

  private validatePigenDirectory(): boolean {
    const dirStat = fs.statSync(this.piGenDirectory)

    if (!dirStat.isDirectory()) {
      core.debug(`Not a directory: ${this.piGenDirectory}`)
      return false
    }

    const piGenDirContent = fs.readdirSync(this.piGenDirectory, {
      withFileTypes: true
    })
    const requiredFiles = ['build-docker.sh', 'Dockerfile']
    const requiredDirectories = Object.values(PiGenStages).filter(
      value => typeof value === 'string'
    ) as string[]
    const existingFiles = piGenDirContent
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
    const existingDirectories = piGenDirContent
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)

    if (!requiredFiles.every(file => existingFiles.includes(file))) {
      core.debug(
        `Not all required files in pi-gen dir. Required: ${requiredFiles.join(
          ', '
        )} but found ${existingFiles.join(', ')}`
      )
      return false
    }

    if (!requiredDirectories.every(dir => existingDirectories.includes(dir))) {
      core.debug(
        `Not all required directories in pi-gen dir. Required: ${requiredDirectories.join(
          ', '
        )} but found ${existingDirectories.join(', ')}`
      )
      return false
    }

    return true
  }

  private getStagesAsDockerMounts(): string {
    return this.config.stageList
      .map(userStageDir => fs.realpathSync(userStageDir))
      .map(userStageDir => `-v ${userStageDir}:${userStageDir}`)
      .join(' ')
  }

  private logOutput(
    line: string,
    verbose: boolean,
    stream: 'info' | 'warning'
  ): void {
    if (verbose || this.piGenBuildLogPattern.test(line)) {
      stream === 'info' ? core.info(line) : core.warning(line)
    }
  }

  private async configureStageExport(
    stageDir: string,
    exportType: 'image' | 'noobs',
    targetState: boolean
  ): Promise<void> {
    const exportFileName =
      exportType === 'image' ? 'EXPORT_IMAGE' : 'EXPORT_NOOBS'
    const configPath = `${stageDir}/${exportFileName}`

    if (!targetState) {
      await io.rmRF(configPath)
    } else if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, '')
    }
  }

  private async configureImageExports(): Promise<void> {
    const lastStage = this.config.stageList.at(-1)

    if (!lastStage) {
      throw new Error('stage list is empty')
    }

    if (this.config.exportLastStageOnly) {
      for (const stage of this.config.stageList.slice(0, -1)) {
        await this.configureStageExport(stage, 'image', false)
        await this.configureStageExport(stage, 'noobs', false)
      }

      await this.configureStageExport(lastStage, 'image', true)

      if (this.config.enableNoobs) {
        await this.configureStageExport(lastStage, 'noobs', true)
      }
    } else {
      // In this case, only warn about missing export if last stage is a custom stage.
      // Add any EXPORT_NOOBS, if missing
      if (!Object.values(PiGenStages).includes(path.basename(lastStage))) {
        const imageGlob = await glob.create(`${lastStage}/EXPORT_IMAGE`, {
          matchDirectories: false
        })
        if ((await imageGlob.glob()).length === 0) {
          core.warning(
            `User stage ${lastStage} does not have an EXPORT_IMAGE directive and will not be included in the generated image`
          )
        }
      }

      for (const stage of this.config.stageList) {
        const exportGlob = await glob.create(`${stage}/EXPORT*`, {
          matchDirectories: false
        })
        const exportDirectives = await exportGlob.glob()

        if (
          exportDirectives.some(p => p.endsWith('EXPORT_IMAGE')) &&
          exportDirectives.length === 1
        ) {
          fs.writeFileSync(`${stage}/EXPORT_NOOBS`, '')
          core.notice(`Created NOOBS export directive in ${stage}`)
        }
      }
    }
  }
}
