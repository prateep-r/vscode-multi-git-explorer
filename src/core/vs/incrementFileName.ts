/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `incrementFileName` from microsoft/vscode 1.145.1,
// src/vs/workbench/contrib/files/browser/fileActions.ts, rewritten from the
// shipped build with the same steps and expressions. It names the copy of an
// item pasted where its name is taken, per `explorer.incrementalNaming`.
import * as path from 'path';

const MAX_SAFE_SMALL_INTEGER = 1 << 30;

export function incrementFileName(name: string, isFolder: boolean, incrementalNaming: 'simple' | 'smart'): string {
  if (incrementalNaming === 'simple') {
    let namePrefix = name;
    let extSuffix = '';
    if (!isFolder) {
      extSuffix = path.posix.extname(name);
      namePrefix = path.posix.basename(name, extSuffix);
    }

    // name copy 5(.txt) => name copy 6(.txt)
    // name copy(.txt) => name copy 2(.txt)
    const suffixRegex = /^(.+ copy)( \d+)?$/;
    if (suffixRegex.test(namePrefix)) {
      return (
        namePrefix.replace(suffixRegex, (match, g1: string, g2?: string) => {
          const number = g2 ? parseInt(g2) : 1;
          return number === 0 ? `${g1}` : number < MAX_SAFE_SMALL_INTEGER ? `${g1} ${number + 1}` : `${g1}${g2} copy`;
        }) + extSuffix
      );
    }

    // name(.txt) => name copy(.txt)
    return `${namePrefix} copy${extSuffix}`;
  }

  const separators = '[\\.\\-_]';
  const maxNumber = MAX_SAFE_SMALL_INTEGER;

  // file.1.txt=>file.2.txt
  const suffixFileRegex = RegExp('(.*' + separators + ')(\\d+)(\\..*)$');
  if (!isFolder && name.match(suffixFileRegex)) {
    return name.replace(suffixFileRegex, (match, g1: string, g2: string, g3: string) => {
      const number = parseInt(g2);
      return number < maxNumber ? g1 + String(number + 1).padStart(g2.length, '0') + g3 : `${g1}${g2}.1${g3}`;
    });
  }

  // 1.file.txt=>2.file.txt
  const prefixFileRegex = RegExp('(\\d+)(' + separators + '.*)(\\..*)$');
  if (!isFolder && name.match(prefixFileRegex)) {
    return name.replace(prefixFileRegex, (match, g1: string, g2: string, g3: string) => {
      const number = parseInt(g1);
      return number < maxNumber ? String(number + 1).padStart(g1.length, '0') + g2 + g3 : `${g1}${g2}.1${g3}`;
    });
  }

  // 1.txt=>2.txt
  const prefixFileNoNameRegex = RegExp('(\\d+)(\\..*)$');
  if (!isFolder && name.match(prefixFileNoNameRegex)) {
    return name.replace(prefixFileNoNameRegex, (match, g1: string, g2: string) => {
      const number = parseInt(g1);
      return number < maxNumber ? String(number + 1).padStart(g1.length, '0') + g2 : `${g1}.1${g2}`;
    });
  }

  // file.txt=>file.1.txt
  const lastIndexOfDot = name.lastIndexOf('.');
  if (!isFolder && lastIndexOfDot >= 0) {
    return `${name.substr(0, lastIndexOfDot)}.1${name.substr(lastIndexOfDot)}`;
  }

  // 123 => 124
  const noNameNoExtensionRegex = RegExp('(\\d+)$');
  if (!isFolder && lastIndexOfDot === -1 && name.match(noNameNoExtensionRegex)) {
    return name.replace(noNameNoExtensionRegex, (match, g1: string) => {
      const number = parseInt(g1);
      return number < maxNumber ? String(number + 1).padStart(g1.length, '0') : `${g1}.1`;
    });
  }

  // file => file1
  // file1 => file2
  const noExtensionRegex = RegExp('(.*)(\\d*)$');
  if (!isFolder && lastIndexOfDot === -1 && name.match(noExtensionRegex)) {
    return name.replace(noExtensionRegex, (match, g1: string, g2: string) => {
      let number = parseInt(g2);
      if (isNaN(number)) {
        number = 0;
      }
      return number < maxNumber ? g1 + String(number + 1).padStart(g2.length, '0') : `${g1}${g2}.1`;
    });
  }

  // folder.1=>folder.2
  if (isFolder && name.match(/(\d+)$/)) {
    return name.replace(/(\d+)$/, (match, ...groups: string[]) => {
      const number = parseInt(groups[0]);
      return number < maxNumber ? String(number + 1).padStart(groups[0].length, '0') : `${groups[0]}.1`;
    });
  }

  // 1.folder=>2.folder
  if (isFolder && name.match(/^(\d+)/)) {
    return name.replace(/^(\d+)(.*)$/, (match, ...groups: string[]) => {
      const number = parseInt(groups[0]);
      return number < maxNumber ? String(number + 1).padStart(groups[0].length, '0') + groups[1] : `${groups[0]}${groups[1]}.1`;
    });
  }

  // file/folder=>file.1/folder.1
  return `${name}.1`;
}
