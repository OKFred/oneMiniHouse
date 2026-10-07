/**
 * @author Fred
 * @desc 将部分html/css/数据转换为canvas
 * @since 2023-04-14 00:22:00
 */

/**
 * @description: 将样式转换为canvas样式
 * @param {String} css 样式字符串
 * @return {Object} ctx canvas对象
 * @example: styleToCanvas.call(ctx, "font-size: 20px; color: #333333;")
 **/
function styleToCanvas(css) {
    let ctx = this;
    let cssArr = css.split(";");
    for (let str of cssArr) {
        let arr = str.split(":");
        let key = arr[0]?.trim();
        let value = arr[1]?.trim();
        if (key === "font-size") {
            let fontSize = value.replace("px", "");
            ctx.setFontSize(fontSize);
        } else if (key === "color") {
            ctx.setFillStyle(value);
        }
    }
    return ctx;
}

/**
 * @description: 将表格数据转换为canvas
 * @param {Array} tableArr 表格数据
 * @param {Number} start_x 起始x坐标
 * @param {Number} start_y 起始y坐标
 * @param {Number} gap_x x轴间距
 * @param {Number} gap_y y轴间距
 * @return {Object} ctx canvas对象
 * @example: tableToCanvas.call(ctx, tableArr, 20, 20, 200, 30)
 * @example: tableArr = [{label: "姓名", value: "张三"}, {label: "年龄", value: "18"}]
 **/
function tableToCanvas(tableArr, start_x, start_y, gap_x, gap_y) {
    let ctx = this;
    for (let i = 0; i < tableArr.length; i++) {
        let obj = tableArr[i];
        ctx.setTextAlign("left");
        ctx.setFillStyle("#333333");
        ctx.fillText(obj.label, start_x, start_y + i * gap_y);
        ctx.setTextAlign("right");
        ctx.setFillStyle("#999999");
        ctx.fillText(obj.value, start_x + gap_x, start_y + i * gap_y);
    }
    return ctx;
}

/**
 * @description: 将标题转换为canvas
 * @param {String} title 标题
 * @param {Number} start_x 起始x坐标
 * @param {Number} start_y 起始y坐标
 * @return {Object} ctx canvas对象
 * @example: titleToCanvas.call(ctx, "标题", 20, 20)
 **/
function titleToCanvas(title, start_x, start_y) {
    let ctx = this;
    ctx.setTextAlign("center");
    ctx.fillText(title, start_x, start_y);
    return ctx;
}

/**
 * @description: 将文本转换为canvas
 * @param {String} text 文本
 * @param {Number} start_x 起始x坐标
 * @param {Number} start_y 起始y坐标
 * @return {Object} ctx canvas对象
 * @example: textToCanvas.call(ctx, "文本", 20, 20)
 **/
function textToCanvas(text, start_x, start_y) {
    let ctx = this;
    ctx.fillText(text, start_x, start_y);
    return ctx;
}

/**
 * @description: 将横线转换为canvas
 * @param {Number} start_x 起始x坐标
 * @param {Number} start_y 起始y坐标
 * @param {Number} gap_x x轴间距
 * @return {Object} ctx canvas对象
 * @example: hrToCanvas.call(ctx, 20, 20, 200)
 * @example: ctx.setLineDash([2, 4], 5); // 设置虚线
 **/
function hrToCanvas(start_x, start_y, gap_x) {
    let ctx = this;
    ctx.setLineDash([2, 4], 5);
    ctx.beginPath();
    ctx.moveTo(start_x, start_y);
    ctx.lineTo(start_x + gap_x, start_y);
    ctx.stroke();
    return ctx;
}

/**
 * @description: 将图片转换为canvas
 * @param {String} src 图片路径
 * @param {Number} start_x 起始x坐标
 * @param {Number} start_y 起始y坐标
 * @param {Number} scale 缩放比例
 * @return {Object} ctx canvas对象
 * @example: imageToCanvas.call(ctx, "https://www.baidu.com/img/bd_logo1.png", 20, 20, 0.5)
 **/
async function imageToCanvas(src, start_x, start_y, scale = 1) {
    let ctx = this;
    let res = await uni.getImageInfo({ src });
    let { width: imgWidth, height: imgHeight } = res;
    let canvasWidth = imgWidth * scale;
    let canvasHeight = imgHeight * scale;
    ctx.drawImage(res.path, start_x, start_y, canvasWidth, canvasHeight);
    return ctx;
}

export { styleToCanvas, tableToCanvas, titleToCanvas, textToCanvas, hrToCanvas, imageToCanvas };
