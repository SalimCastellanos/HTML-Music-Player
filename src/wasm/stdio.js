import {console, Uint8Array, FileReaderSync, Blob} from "platform/platform";
import {NullPointerError} from "wasm/WebAssemblyWrapper";

const i8 = 1;
const i16 = 2;
const i32 = 4;
const f64 = 8;
const i64 = 16;

const printFSizeMap = new Uint8Array(128);
printFSizeMap[102] =
printFSizeMap[70] =
printFSizeMap[101] =
printFSizeMap[69] =
printFSizeMap[97] =
printFSizeMap[65] =
printFSizeMap[103] =
printFSizeMap[71] = f64;

printFSizeMap[99] =
printFSizeMap[100] =
printFSizeMap[105] =
printFSizeMap[111] =
printFSizeMap[120] =
printFSizeMap[88] =
printFSizeMap[117] =
printFSizeMap[115] =
printFSizeMap[112] = i32;

printFSizeMap[104] = i16;
printFSizeMap[106] = i32;
printFSizeMap[122] = i32;
printFSizeMap[116] = i32;
printFSizeMap[76] = f64;
printFSizeMap[108] = i32;

const stdio = [null, msg => console.log(msg), msg => console.error(msg)];
const rspecifier = /%([-+#0 ]?[0-9*]?)(\.[0-9*])?(hh|h|j|z|t|L|ll|l)?([%sgGnpaAeEfFuxXodic])/g;

class FHandle {
    constructor(fileHandle, blob, mode) {
        this._fileHandle = fileHandle;
        this._blob = blob;
        this._position = 0;
        this._eof = false;
        this._error = null;
        this._binary = mode.indexOf(`b`) >= 0;
        this._size = blob.size;
    }

    _fseek(offset, origin) {
        if (!this._binary) {
            if (origin === 0) {
                this._position = this._validPositionForSet(offset);
            } else {
                this._error = 22;
                return -1;
            }
        } else {
            if (origin === 0) {
                this._position = this._validPositionForSet(offset);
            } else if (origin === 1) {
                this._position = this._validPositionForSet(this._position + offset);
            } else if (origin === 2) {
                this._position = this._validPositionForSet(this._size + offset);
            } else {
                this._error = 22;
                return -1;
            }
        }
        this._eof = false;
        return 0;
    }

    _resetMode(mode) {
        this._binary = mode.indexOf(`b`) >= 0;
        this._error = null;
        this._eof = false;
        this._position = 0;
        return this._fileHandle;
    }

    _validPositionForSet(position) {
        if (position >= this._size) {
            position = this._size;
            this._eof = true;
        }
        this._position = position;
    }

    _fread(wasm, targetPtr, length) {
        const fileStart = this._position;
        this._validPositionForSet(fileStart + length);
        const lengthToRead = this._position - fileStart;
        const slicedBlob = this._blob.slice(fileStart, fileStart + lengthToRead + 1, this._blob.type);
        const reader = new FileReaderSync();
        const src = reader.readAsArrayBuffer(slicedBlob);
        const dst = wasm.u8view(targetPtr, lengthToRead);
        dst.set(new Uint8Array(src));
        return lengthToRead;
    }
}

function format(wasm, formatStringPtr, argvPtr) {
    const formatString = wasm.convertCharPToAsciiString(formatStringPtr);
    if (argvPtr) {
        let startIndex = 0;
        let m;
        let ret = ``;
        const view = wasm._view;
        let offset = argvPtr;

        while (m = rspecifier.exec(formatString)) {
            const endIndex = rspecifier.lastIndex - m[0].length;
            const inb = formatString.slice(startIndex, endIndex);
            ret += inb;
            startIndex = rspecifier.lastIndex;

            const specifier = m[4].charCodeAt(0);

            if (specifier === 37) {
                ret += m[4];
            } else if (specifier === 99) {
                ret += String.fromCharCode(wasm.u32(offset));
                offset += 4;
            } else if (specifier === 115) {
                const ptr = wasm.u32(offset);
                offset += 4;
                ret += wasm.convertCharPToAsciiString(ptr);
            } else if (specifier === 112) {
                ret += `b${wasm.u32(offset).toString(16).padStart(8, `0`)}`;
                offset += 4;
            } else if (printFSizeMap[specifier] === i32) {
                const signed = specifier === 100 || specifier === 105;
                const m3 = m[3];
                const m3Length = m3 ? m3.length : 0;
                if (m3Length === 0) {
                    ret += String(signed ? wasm.i32(offset) : wasm.u32(offset));
                    offset += 4;
                } else if (m3Length === 1) {
                    const isShort = m3.charCodeAt(0) === 104;
                    if (isShort) {
                        ret += String(signed ? wasm.i16(offset) : wasm.u16(offset));
                    } else {
                        ret += String(signed ? wasm.i32(offset) : wasm.u32(offset));
                    }
                    offset += 4;
                } else {
                    const cc = m3.charCodeAt(0);
                    if (cc === 104) {
                        ret += String(signed ? wasm.i8(offset) : wasm.u8(offset));
                        offset += 4;
                    } else {
                        const alignedOffset = (offset + 7) & ~7;
                        ret += signed ? `${wasm.i64AsDouble(alignedOffset)}`
                                      : `${wasm.u64AsDouble(alignedOffset)}`;
                        offset = alignedOffset + 8;
                    }
                }
            } else if (printFSizeMap[specifier] === f64) {
                const alignedOffset = (offset + 7) & ~7;
                const value = wasm.f64(alignedOffset);
                const [frac] = wasm.cmath.modf(value);
                if (frac === 0) {
                    ret += value.toFixed(1);
                } else {
                    ret += String(value);
                }
                offset = alignedOffset + 8;
            } else if (specifier === 110) {
                const m3 = m[3];
                const m3Length = m3 ? m3.length : 0;
                const ptr = wasm.u32(offset);
                let size = 4;
                if (m3Length > 0) {
                    const cc = m3.charCodeAt(0);
                    if (m3Length > 1) {
                        size = cc === 104 ? i8 : i64;
                    } else {
                        size = printFSizeMap[cc];
                    }

                    if (size === i8) {
                        view.setUint8(ptr, ret.length, true);
                    } else if (size === i16) {
                        view.setUint16(ptr, ret.length, true);
                    } else if (size === i32) {
                        view.setUint32(ptr, ret.length, true);
                    }
                } else {
                    view.setUint32(ptr, ret.length, true);
                }
                offset += 4;
            }
        }

        if (startIndex > 0) {
            ret += formatString.slice(startIndex);
        }
        return ret;
    } else {
        return formatString;
    }
}

export default function createCStdio(wasm) {

    const fprintf = function(filePtr, formatStringPtr, argvPtr) {
        const out = stdio[filePtr] || stdio[1];
        const str = format(wasm, formatStringPtr, argvPtr);
        out(str);
        return str.length;
    };

    const printf = function(formatStringPtr, argvPtr) {
        const str = format(wasm, formatStringPtr, argvPtr);
        console.log(str);
        return str.length;
    };

    const snprintf = function(targetPtr, targetLength, formatStringPtr, argvPtr) {
        const str = format(wasm, formatStringPtr, argvPtr);
        wasm.convertAsciiStringToCharPAt(str, targetPtr, targetLength);
        return str.length;
    };

    const sprintf = function(targetPtr, formatStringPtr, argvPtr) {
        const str = format(wasm, formatStringPtr, argvPtr);
        wasm.convertAsciiStringToCharPAt(str, targetPtr);
        return str.length;
    };

    const fputs = function(ptr, fptr) {
        if (fptr <= 2) {
            const out = stdio[fptr] || stdio[1];
            out(wasm.convertCharPToAsciiString(ptr));
            return 0;
        } else {
            return -1;
        }
    };

    const fputc = function(ch, fptr) {
        if (fptr <= 2) {
            const out = stdio[fptr] || stdio[1];
            out(String.fromCharCode(ch));
            return ch;
        } else {
            return -1;
        }
    };

    return {
        fprintf,
        printf,
        snprintf,
        sprintf,
        vsprintf: sprintf,
        vsnprintf: snprintf,
        vprintf: printf,
        vfprintf: fprintf,
        fputs,
        fputc,
        putchar(ch) {
            fputc(ch, 1);
        },


        puts(ptr) {
            console.log(wasm.convertCharPToAsciiString(ptr));
            return 0;
        },

        putc: fputc,

        time(ptr) {
            const ret = Date.now() / 1000 | 0;
            if (ptr) {
                wasm.setU32(ptr, ret);
            }
            return ret;
        },

        abort() {
            throw new Error(`abort called`);
        },

        fgetpos(fileHandle, posPtr) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return -1;
            }

            wasm._view.setUint32(posPtr, file._position, true);
            return 0;
        },

        fsetpos(fileHandle, posPtr) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return -1;
            }
            file._validPositionForSet(wasm.u32(posPtr));
            file._eof = false;
            return 0;
        },

        ferror(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return -1;
            }

            return file._error ? -2 : 0;
        },

        clearerr(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                return;
            }
            file._error = null;
            file._eof = false;
        },

        perror(strPtr) {
            const str = strPtr ? `${wasm.convertCharPToAsciiString(strPtr)}: ` : ``;
            console.error(`${str}ERRNO=${wasm.getErrNo()}`);
        },


        fseek(fileHandle, offset, origin) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }

            return file._fseek(offset, origin);
        },

        ftell(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return -1;
            }

            return file._position;
        },

        rewind(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                return;
            }

            file._position = 0;
            file._error = null;
            file._eof = false;
        },

        feof(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }
            return file._eof ? -1 : 0;
        },

        freopen(fileNamePtr, modePtr, fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }

            if (!fileNamePtr) {
                return file._resetMode(wasm.convertCharPToAsciiString(modePtr));
            }
            const fileName = wasm.convertCharPToAsciiString(fileNamePtr);
            const mode = wasm.convertCharPToAsciiString(modePtr);
            const blob = wasm._getFile(fileName, mode);

            if (!blob) {
                wasm._setErrNo(2);
                return 0;
            }

            wasm._files.set(fileHandle, new FHandle(fileHandle, blob, mode));
            return fileHandle;
        },


        fopen(fileNamePtr, modePtr) {
            const fileName = wasm.convertCharPToAsciiString(fileNamePtr);
            const mode = modePtr ? wasm.convertCharPToAsciiString(modePtr) : `r`;
            const file = wasm._getFile(fileName, mode);

            if (!file) {
                wasm._setErrNo(2);
                return 0;
            }

            if (!(file instanceof Blob)) {
                throw new TypeError(`expecting a Blob or File but got ${typeof file} (${({}.toString.call(file))})`);
            }

            const nextHandle = wasm._nextHandle();

            if (nextHandle < 0) {
                wasm._setErrNo(24);
                return 0;
            }

            wasm._files.set(nextHandle, new FHandle(nextHandle, file, mode));

            return nextHandle;
        },

        fwrite(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }
            file._error = 30;
            return 0;
        },

        fflush(fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }
            file._error = 30;
            return -1;
        },


        fread(targetPtr, size, count, fileHandle) {
            const file = wasm._files.get(fileHandle);

            if (!file) {
                wasm._setErrNo(77);
                return 0;
            }

            if (!size || !count) {
                return 0;
            }

            const bytesToRead = size * count;

            return file._fread(wasm, targetPtr, bytesToRead);
        },

        fclose(fileHandle) {
            const file = wasm._files.get(fileHandle);
            if (!file) {
                wasm._setErrNo(77);
                return -1;
            }

            if (file._fileHandle !== fileHandle) {
                throw new NullPointerError();
            }
            wasm._files.delete(fileHandle);
            wasm._freeHandle(fileHandle);

            return 0;

        },

        remove() {
            return 0;
        },

        rename() {
            return 0;
        }
    };
}