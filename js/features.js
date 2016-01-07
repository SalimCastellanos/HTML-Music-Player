"use strict";
const $ = require("../lib/jquery");

var features = module.exports;
var input = document.createElement("input");

features.allowMimes = ["audio/mp3", "audio/mpeg"];
features.allowExtensions = "mp3,mpg,mpeg".split(",");

features.readFiles = typeof FileReader == "function" && new FileReader()
    .readAsBinaryString;
features.directories = ("webkitdirectory" in input ||
    "directory" in input ||
    "mozdirectory" in input);
features.touch = (('ontouchstart' in window) ||
    navigator.maxTouchPoints > 0 ||
    navigator.msMaxTouchPoints > 0 ||
    (window.DocumentTouch && (document instanceof window.DocumentTouch)));

if (!features.touch) {
    $("body").addClass("no-touch");
}
