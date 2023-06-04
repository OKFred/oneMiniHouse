/* function defaultTask(cb) {
  // place code for your default task here
  const { src, dest } = require('gulp');

  exports.default = function () {
    return src('src/*.js').pipe(dest('output/'));
  };
  cb();
}

exports.default = defaultTask; */

const { src, dest } = require('gulp');

/* gulp traversal files, folders, and subfolders */
exports.default = function () {
  return src('dist/build/h5/**/*').pipe(dest('//172.28.0.61/open/www/html/minihouse'));
};
