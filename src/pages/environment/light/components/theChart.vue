<template>
  <view class="ec-container">
    <ec-canvas canvas-id="echart" id="echart" ref="echart" :ec="localObj.echartObj.ec" />
  </view>
  <view style="margin-top: 1rem" />
  <view style="width: 100%" @tap="onToggleGraph">
    <mybuttond :parentObj="localObj.echartObj.buttons" />
  </view>
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
import mybuttond from "/src/components/mybuttond/index.vue"; //引入组件
// import echarts from "/src/components/ec-canvas/echarts.js"; //引入组件

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;


const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  // debug: true,
  echartObj: {
    chart: null,
    ec: {
      // onInit: initChart,
      lazyLoad: true,
    }, // 将 lazyLoad 设为 true 后，需要手动初始化图表
    isLoaded: false,
    isDisposed: false,
    isPaused: false,
    optionObj: {
      animationDuration: 800,
      title: {
        show: false
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          animation: false
        }
      },
      /*       toolbox: {
              feature: {
                saveAsImage: {}
              }
            }, */
      legend: {
        type: 'scroll',
        animation: false,
        data: ['光照(lux)']
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '1%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: [],
        splitLine: {
          show: false
        }
      },
      yAxis: {
        type: 'value',
        splitLine: {
          show: false
        }
      },
      series: [
        {
          name: '光照(lux)',
          type: 'line',
          smooth: true,
          data: [],
        }
      ]
    },
    initChart,
    dispose,
    buttons: {
      text: "加载中",
      color: 'red-plain',
      size: 'medium'
    },
  }
});

let graphInterval = null; //定时器
onMounted(() => {
  console.log('进入页面')
  graphInterval = setInterval(() => {
    if (props.localObj.echartObj.isPaused) return;
    initChart();
  }, 3000)
})

onBeforeUnmount(() => {
  console.log('离开页面')
  clearInterval(graphInterval);
})

function dispose() {
  if (props.localObj.echartObj.chart) {
    props.localObj.echartObj.chart.dispose();
    props.localObj.echartObj.isDisposed = true;
  }
}

function onToggleGraph() {
  console.log('图表状态切换');
  props.localObj.echartObj.isPaused = !props.localObj.echartObj.isPaused;
  props.localObj.echartObj.buttons.text = props.localObj.echartObj.isPaused ? '已暂停' : '加载中';
  props.localObj.echartObj.buttons.color = props.localObj.echartObj.isPaused ? 'blue-plain' : 'red-plain';
}

function initChart() {
  const current = Taro.getCurrentInstance()
  let myChart = current.page.selectComponent('#echart');
  if (!myChart) return console.log('图表不存在或者未识别')
  myChart.init((canvas, width, height) => {
    const chart = echarts.init(canvas, null, {
      width,
      height,
    });
    canvas.setChart(chart);
    chart.setOption(props.localObj.echartObj.optionObj);
    props.localObj.echartObj.isLoaded = true;
    props.localObj.echartObj.chart = chart;
    return chart;
  })
}
setTimeout(initChart, 500);


watch(
  () => props.localObj.formCollection['主表单'],
  (newValue, oldValue) => {
    if (newValue && newValue.length > 0) {
      let lightnessArr = newValue.map(obj => obj['lightness']);
      let timeArr = newValue.map(obj => new Date(obj.query_time).Format('hh:mm:ss'));
      let { xAxis, series, legend } = props.localObj.echartObj.optionObj;
      xAxis.data = timeArr;
      let legendArr = ['光照(lux)'];
      let dataArr = [lightnessArr];
      // legend.data = legendArr;
      legendArr.forEach((name, index) => {
        series[index] = {
          name,
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: dataArr[index]
        }
      })
    }
  },
  { deep: true },
);

</script>

<style>
.ec-container {
  width: 100%;
  height: 50vh;
}

ec-canvas {
  width: 100%;
  height: 100%;
}
</style>
