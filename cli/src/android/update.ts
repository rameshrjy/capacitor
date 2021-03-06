import { Config } from '../config';
import {
  checkPlatformVersions,
  logFatal,
  resolveNode,
  runTask,
} from '../common';
import { getAndroidPlugins } from './common';
import {
  checkAndInstallDependencies,
  handleCordovaPluginsJS,
  writeCordovaAndroidManifest,
} from '../cordova';
import {
  convertToUnixPath,
  copySync,
  existsSync,
  readFileAsync,
  removeSync,
  writeFileAsync,
} from '../util/fs';
import { join, relative, resolve } from 'path';
import {
  Plugin,
  PluginType,
  getAllElements,
  getFilePath,
  getPlatformElement,
  getPluginPlatform,
  getPluginType,
  getPlugins,
  printPlugins,
} from '../plugin';

const platform = 'android';

export async function updateAndroid(config: Config) {
  let plugins = await getPluginsTask(config);

  const capacitorPlugins = plugins.filter(
    p => getPluginType(p, platform) === PluginType.Core,
  );

  let needsPluginUpdate = true;
  while (needsPluginUpdate) {
    needsPluginUpdate = await checkAndInstallDependencies(
      config,
      plugins,
      platform,
    );
    if (needsPluginUpdate) {
      plugins = await getPluginsTask(config);
    }
  }

  printPlugins(capacitorPlugins, 'android');

  removePluginsNativeFiles(config);
  const cordovaPlugins = plugins.filter(
    p => getPluginType(p, platform) === PluginType.Cordova,
  );
  if (cordovaPlugins.length > 0) {
    copyPluginsNativeFiles(config, cordovaPlugins);
  }
  await handleCordovaPluginsJS(cordovaPlugins, config, platform);
  await installGradlePlugins(config, capacitorPlugins, cordovaPlugins);
  await handleCordovaPluginsGradle(config, cordovaPlugins);
  await writeCordovaAndroidManifest(cordovaPlugins, config, platform);

  const incompatibleCordovaPlugins = plugins.filter(
    p => getPluginType(p, platform) === PluginType.Incompatible,
  );
  printPlugins(incompatibleCordovaPlugins, platform, 'incompatible');
  await checkPlatformVersions(config, platform);
}

function getGradlePackageName(id: string): string {
  return id.replace('@', '').replace('/', '-');
}

export async function installGradlePlugins(
  config: Config,
  capacitorPlugins: Plugin[],
  cordovaPlugins: Plugin[],
) {
  const capacitorAndroidPath = resolveNode(
    config,
    '@capacitor/android',
    'capacitor',
  );
  if (!capacitorAndroidPath) {
    logFatal(
      `Unable to find node_modules/@capacitor/android/capacitor. Are you sure`,
      `@capacitor/android is installed? This file is currently required for Capacitor to function.`,
    );
    return;
  }

  const settingsPath = join(config.app.rootDir, 'android');
  const dependencyPath = join(config.app.rootDir, 'android', 'app');
  const relativeCapcitorAndroidPath = convertToUnixPath(
    relative(settingsPath, capacitorAndroidPath),
  );
  const settingsLines = `// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN
include ':capacitor-android'
project(':capacitor-android').projectDir = new File('${relativeCapcitorAndroidPath}')
${capacitorPlugins
  .map(p => {
    const relativePluginPath = convertToUnixPath(
      relative(settingsPath, p.rootPath),
    );
    return `
include ':${getGradlePackageName(p.id)}'
project(':${getGradlePackageName(
      p.id,
    )}').projectDir = new File('${relativePluginPath}/${p.android!.path}')
`;
  })
  .join('')}`;

  let applyArray: Array<any> = [];
  let frameworksArray: Array<any> = [];
  let prefsArray: Array<any> = [];
  cordovaPlugins.map(p => {
    const relativePluginPath = convertToUnixPath(
      relative(dependencyPath, p.rootPath),
    );
    const frameworks = getPlatformElement(p, platform, 'framework');
    frameworks.map((framework: any) => {
      if (
        framework.$.custom &&
        framework.$.custom === 'true' &&
        framework.$.type &&
        framework.$.type === 'gradleReference'
      ) {
        applyArray.push(
          `apply from: "${relativePluginPath}/${framework.$.src}"`,
        );
      } else if (!framework.$.type && !framework.$.custom) {
        frameworksArray.push(`    implementation "${framework.$.src}"`);
      }
    });
    prefsArray = prefsArray.concat(getAllElements(p, platform, 'preference'));
  });
  let frameworkString = frameworksArray.join('\n');
  frameworkString = await replaceFrameworkVariables(
    config,
    prefsArray,
    frameworkString,
  );
  const dependencyLines = `// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN

android {
  compileOptions {
      sourceCompatibility JavaVersion.VERSION_1_8
      targetCompatibility JavaVersion.VERSION_1_8
  }
}

apply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"
dependencies {
${capacitorPlugins
  .map(p => {
    return `    implementation project(':${getGradlePackageName(p.id)}')`;
  })
  .join('\n')}
${frameworkString}
}
${applyArray.join('\n')}

if (hasProperty('postBuildExtras')) {
  postBuildExtras()
}
`;

  await writeFileAsync(
    join(settingsPath, 'capacitor.settings.gradle'),
    settingsLines,
  );
  await writeFileAsync(
    join(dependencyPath, 'capacitor.build.gradle'),
    dependencyLines,
  );
}

export async function handleCordovaPluginsGradle(
  config: Config,
  cordovaPlugins: Plugin[],
) {
  const pluginsFolder = resolve(
    config.app.rootDir,
    'android',
    config.android.assets.pluginsFolderName,
  );
  const pluginsGradlePath = join(pluginsFolder, 'build.gradle');
  let frameworksArray: Array<any> = [];
  let prefsArray: Array<any> = [];
  let applyArray: Array<any> = [];
  applyArray.push(`apply from: "cordova.variables.gradle"`);
  cordovaPlugins.map(p => {
    const relativePluginPath = convertToUnixPath(
      relative(pluginsFolder, p.rootPath),
    );
    const frameworks = getPlatformElement(p, platform, 'framework');
    frameworks.map((framework: any) => {
      if (!framework.$.type && !framework.$.custom) {
        frameworksArray.push(framework.$.src);
      } else if (
        framework.$.custom &&
        framework.$.custom === 'true' &&
        framework.$.type &&
        framework.$.type === 'gradleReference'
      ) {
        applyArray.push(
          `apply from: "${relativePluginPath}/${framework.$.src}"`,
        );
      }
    });
    prefsArray = prefsArray.concat(getAllElements(p, platform, 'preference'));
  });
  let frameworkString = frameworksArray
    .map(f => {
      return `    implementation "${f}"`;
    })
    .join('\n');
  frameworkString = await replaceFrameworkVariables(
    config,
    prefsArray,
    frameworkString,
  );
  let applyString = applyArray.join('\n');
  let buildGradle = await readFileAsync(pluginsGradlePath, 'utf8');
  buildGradle = buildGradle.replace(
    /(SUB-PROJECT DEPENDENCIES START)[\s\S]*(\/\/ SUB-PROJECT DEPENDENCIES END)/,
    '$1\n' + frameworkString.concat('\n') + '    $2',
  );
  buildGradle = buildGradle.replace(
    /(PLUGIN GRADLE EXTENSIONS START)[\s\S]*(\/\/ PLUGIN GRADLE EXTENSIONS END)/,
    '$1\n' + applyString.concat('\n') + '$2',
  );
  await writeFileAsync(pluginsGradlePath, buildGradle);
  const cordovaVariables = `// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN
ext {
  cdvMinSdkVersion = project.hasProperty('minSdkVersion') ? rootProject.ext.minSdkVersion : ${config.android.minVersion}
  // Plugin gradle extensions can append to this to have code run at the end.
  cdvPluginPostBuildExtras = []
}`;
  await writeFileAsync(
    join(pluginsFolder, 'cordova.variables.gradle'),
    cordovaVariables,
  );
}

function copyPluginsNativeFiles(config: Config, cordovaPlugins: Plugin[]) {
  const pluginsRoot = resolve(
    config.app.rootDir,
    'android',
    config.android.assets.pluginsFolderName,
  );
  const pluginsPath = join(pluginsRoot, 'src', 'main');
  cordovaPlugins.map(p => {
    const androidPlatform = getPluginPlatform(p, platform);
    if (androidPlatform) {
      const sourceFiles = androidPlatform['source-file'];
      if (sourceFiles) {
        sourceFiles.map((sourceFile: any) => {
          const fileName = sourceFile.$.src.split('/').pop();
          let baseFolder = 'java/';
          if (fileName.split('.').pop() === 'aidl') {
            baseFolder = 'aidl/';
          }
          const target = sourceFile.$['target-dir']
            .replace('app/src/main/', '')
            .replace('src/', baseFolder);
          copySync(
            getFilePath(config, p, sourceFile.$.src),
            join(pluginsPath, target, fileName),
          );
        });
      }
      const resourceFiles = androidPlatform['resource-file'];
      if (resourceFiles) {
        resourceFiles.map((resourceFile: any) => {
          const target = resourceFile.$['target'];
          if (resourceFile.$.src.split('.').pop() === 'aar') {
            copySync(
              getFilePath(config, p, resourceFile.$.src),
              join(pluginsPath, 'libs', target.split('/').pop()),
            );
          } else if (target !== '.') {
            copySync(
              getFilePath(config, p, resourceFile.$.src),
              join(pluginsPath, target),
            );
          }
        });
      }
      const libFiles = getPlatformElement(p, platform, 'lib-file');
      libFiles.map((libFile: any) => {
        copySync(
          getFilePath(config, p, libFile.$.src),
          join(pluginsPath, 'libs', libFile.$.src.split('/').pop()),
        );
      });
    }
  });
}

function removePluginsNativeFiles(config: Config) {
  const pluginsRoot = resolve(
    config.app.rootDir,
    'android',
    config.android.assets.pluginsFolderName,
  );
  removeSync(pluginsRoot);
  copySync(config.android.assets.pluginsDir, pluginsRoot);
}

async function getPluginsTask(config: Config) {
  return await runTask('Updating Android plugins', async () => {
    const allPlugins = await getPlugins(config);
    const androidPlugins = getAndroidPlugins(allPlugins);
    return androidPlugins;
  });
}

async function replaceFrameworkVariables(
  config: Config,
  prefsArray: Array<any>,
  frameworkString: string,
) {
  const variablesFile = resolve(
    config.app.rootDir,
    'android',
    'variables.gradle',
  );
  let variablesGradle = '';
  if (existsSync(variablesFile)) {
    variablesGradle = await readFileAsync(variablesFile, 'utf8');
  }
  prefsArray.map((preference: any) => {
    if (!variablesGradle.includes(preference.$.name)) {
      frameworkString = frameworkString.replace(
        new RegExp(('$' + preference.$.name).replace('$', '\\$&'), 'g'),
        preference.$.default,
      );
    }
  });
  return frameworkString;
}
