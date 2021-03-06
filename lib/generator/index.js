import fs from "fs";
import { sync as mkdirpSync } from "mkdirp";
import readlineSync from "readline-sync";
import { padStart } from "lodash";
import chalk from "chalk";

import { resolveExternal, exists } from "../utils";
import UserInterrupt from "./user-interrupt";

import {
  GENERATE,
  DESTROY,
  CREATE,
  EXIST,
  IDENTICAL,
  SKIP,
  CONFLICT,
  REMOVE,

  isGenerate,
  getTree,
  logAction,
  writeFile,
  handleError,
  showDiff
} from "./support";

export default class Generator {
  constructor(options, templatePath, outputDir) {
    this.options = options;

    this.templatePath = templatePath;
    if (outputDir) this.outputPath = resolveExternal(outputDir);

    this.excludes = [
      !options.keeps && /\.keep/
    ].filter(Boolean);

    this.dependentGenerators = [];

    this.actions = [];
  }

  generate() {
    try {
      this.tree = this.buildTree(GENERATE);

      for (let step of this.tree) {
        if (step.isAction) {
          step.action(GENERATE);
        } else if (step.stats.isDirectory()) {
          this.generateDirectory(step);
        } else {
          this.generateFile(step);
        }
      }
    } catch (error) {
      handleError(error);
    }
  }

  destroy() {
    try {
      this.tree = this.buildTree(DESTROY);

      for (let step of this.tree) {
        if (step.isAction) {
          step.action(DESTROY);
        } else {
          // Don't try to delete nonexistent files
          if (!exists(step.outputPath)) continue;

          if (step.stats.isDirectory()) {
            this.destroyDirectory(step.outputPath);
          } else {
            this.destroyFile(step.outputPath);
          }
        }
      }
    } catch (error) {
      handleError(error);
    }
  }

  * buildTree(mode) {
    // Don't include any files if templatePath isn't available
    let files = this.templatePath ?
      getTree(
        this.templatePath,
        this.outputPath,
        this.excludes,
        this.options,
        mode
      ) : [];

    let actions = this.actions
      .filter(a => a.modes.includes(mode))
      .map(a => Object.assign(a, { isAction: true }));

    yield* (isGenerate(mode) ? files : actions);
    for (let generator of this.dependentGenerators) {
      yield* generator.buildTree(mode);
    }
    yield* (isGenerate(mode) ? actions : files);
  }

  generateDirectory(dir) {
    if (exists(dir.outputPath)) {
      logAction(EXIST, dir.outputPath);
    } else {
      mkdirpSync(dir.outputPath);
      logAction(CREATE, dir.outputPath);
    }
  }

  generateFile(file) {
    if (!exists(file.outputPath)) return writeFile(file);

    let existingContents = fs.readFileSync(file.outputPath).toString();

    if (existingContents === file.compiledData) {
      logAction(IDENTICAL, file.outputPath);
    } else if (this.overwriteAll) {
      writeFile(file, true);
    } else {
      logAction(CONFLICT, file.outputPath);
      this.resolveConflict(file, existingContents);
    }
  }

  resolveConflict(file, existingContents) {
    const ALLOWED_OPTIONS = {
      Y: "yes, overwrite",
      n: "no, do not overwrite",
      a: "all, overwrite this and all others",
      q: "quit, do not overwrite",
      d: "diff, show the differences between the old and the new",
      h: "help, show this help"
    };

    let option = readlineSync.question(
      `Overwrite ${chalk.bold(file.outputPath)}? (enter "h" for help) [${Object.keys(ALLOWED_OPTIONS).join("")}] `,
      {
        limit: Object.keys(ALLOWED_OPTIONS),
        defaultInput: Object.keys(ALLOWED_OPTIONS)[0]
      }
    ).toLowerCase();

    switch (option) {
      case "a":
        this.overwriteAll = true;
      case "y":
        writeFile(file, true);
        break;
      case "n":
        logAction(SKIP, file.outputPath);
        break;
      case "q":
        this.tree.throw(new UserInterrupt());
        break;
      case "d":
        showDiff(existingContents, file.compiledData);
        this.resolveConflict(file, existingContents);
        break;
      case "h":
        Object.keys(ALLOWED_OPTIONS).forEach(key => {
          console.log(`${padStart(chalk.bold(key), 13)} — ${ALLOWED_OPTIONS[key]}`);
        });

        this.resolveConflict(file, existingContents);
    }
  }

  destroyDirectory(dirPath) {
    if (fs.readdirSync(dirPath).length) {
      // Don't delete nonempty dirs
      logAction(SKIP, dirPath);
    } else {
      fs.rmdirSync(dirPath);
      logAction(REMOVE, dirPath);
    }
  }

  destroyFile(filePath) {
    fs.unlinkSync(filePath);
    logAction(REMOVE, filePath);
  }
}
