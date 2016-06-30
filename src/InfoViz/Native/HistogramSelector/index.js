import CompositeClosureHelper from '../../../Common/Core/CompositeClosureHelper';

import d3 from 'd3';
import style from 'PVWStyle/InfoVizNative/HistogramSelector.mcss';
import multiClicker from '../../Core/D3MultiClick';
// import template from './template.html';

// ----------------------------------------------------------------------------
// Histogram Selector
// ----------------------------------------------------------------------------
//
// This component is designed to display histograms in a grid and support
// user selection of histograms. The idea being to allow the user to view
// histograms for a large number of parameters and then select some of
// those parameters to use in further visualizations.
//
// Due to the large number of DOM elements a histogram can have, we modify
// the standard D3 graph approach to reuse DOM elements as the histograms
// scroll offscreen.  This way we can support thousands of histograms
// while only creating enough DOM elements to fill the screen.
//
// A Transform is used to reposition existing DOM elements as they
// are reused. Supposedly this is a fast operation. The idea comes from
// http://bl.ocks.org/gmaclennan/11130600 among other examples.
// Reuse happens at the row level.
//
// The maxBoxSize variable controls the largest width that a box
// (histogram) will use. This code will fill its container with the
// largest size histogram it can that does not exceed this limit and
// provides an integral number of histograms across the container's width.
//

// This function modifies the Transform property
// of the rows of the grid. Instead of creating new
// rows filled with DOM elements.
const transformCSSProp = (function tcssp(property) {
  const prefixes = ['webkit', 'ms', 'Moz', 'O'];
  let i = -1;
  const n = prefixes.length;
  const s = document.body.style;

  if (property.toLowerCase() in s) {
    return property.toLowerCase();
  }

  while (++i < n) {
    if (prefixes[i] + property in s) {
      return `-${prefixes[i].toLowerCase()}${property.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    }
  }

  return false;
}('Transform'));

// Apply our desired attributes to the grid rows
function styleRows(selection, self) {
  selection
    .classed(style.row, true)
    .style('height', `${self.boxHeight}px`)
    .style(transformCSSProp, (d, i) =>
      `translate3d(0,${d.key * self.boxHeight}px,0)`
    );
}

// apply our desired attributes to the boxes of a row
function styleBoxes(selection, self) {
  selection
    .style('width', `${self.boxWidth}px`)
    .style('height', `${self.boxHeight}px`)
    // .style('margin', `${self.boxMargin / 2}px`)
  ;
}

function histogramSelector(publicAPI, model) {
  // in contact-sheet mode, specify the largest width a histogram can grow
  // to before more histograms are created to fill the container's width
  const maxBoxSize = 240;
  const legendSize = 15;

  function svgWidth() {
    return model.histWidth + model.histMargin.left + model.histMargin.right;
  }
  function svgHeight() {
    return model.histHeight + model.histMargin.top + model.histMargin.bottom;
  }

  function fetchData() {
    model.needData = true;

    if (model.provider) {
      let dataToLoadCount = 0;

      let fieldNames = [];
      // Initialize fields
      if (model.provider.isA('FieldProvider')) {
        fieldNames = model.provider.getFieldNames();
      }

      // Fetch 1D Histogram
      if (model.provider.isA('Histogram1DProvider')) {
        dataToLoadCount += fieldNames.length;
        for (let i = 0; i < fieldNames.length; i++) {
          // Return true if the data is already loaded
          dataToLoadCount -= model.provider.loadHistogram1D(fieldNames[i])
            ? 1 : 0;
        }
      }

      // Fetch Selection
      if (model.provider.isA('SelectionProvider')) {
        // fetchSelectionData();
      }

      // Check if we can render or not
      model.needData = !!dataToLoadCount;

      if (!model.needData) {
        publicAPI.render();
      }
    }
  }

  function updateSizeInformation(singleMode) {
    let updateBoxPerRow = false;
    const clientRect = model.container.getBoundingClientRect();

    // hard coded because I did not figure out how to
    // properly query this value from our container.
    const borderSize = 3;
    // 10 for linux/firefox, 14 for win7/chrome
    const scrollbarWidth = 14;
    const boxOutline = 2;

    // Get the client area size
    const dimensions = [clientRect.width - 2 * borderSize - scrollbarWidth,
                        clientRect.height - 2 * borderSize];

    // compute key values based on our new size
    const boxesPerRow = (singleMode ? 1 : Math.ceil(dimensions[0] / maxBoxSize));
    model.boxWidth = Math.floor(dimensions[0] / boxesPerRow);
    model.boxHeight = (singleMode ? Math.floor(model.boxWidth * 5 / 8) : model.boxWidth);
    model.rowsPerPage = Math.ceil(dimensions[1] / model.boxHeight);

    if (boxesPerRow !== model.boxesPerRow) {
      updateBoxPerRow = true;
      model.boxesPerRow = boxesPerRow;
    }

    model.histWidth = model.boxWidth - boxOutline * 2 -
                      model.histMargin.left - model.histMargin.right;
    // other row size, probably a way to query for this
    const otherRowHeight = 19;
    model.histHeight = model.boxHeight - boxOutline * 2 - otherRowHeight -
                       model.histMargin.top - model.histMargin.bottom;

    return updateBoxPerRow;
  }

  // which row of model.nest does this field name reside in?
  function getFieldRow(name) {
    if (model.nest === null) return 0;
    const foundRow = model.nest.reduce((prev, item, i) => {
      const val = item.value.filter((def) => (def.name === name));
      if (val.length > 0) {
        return item.key;
      }
      return prev;
    }, 0);
    return foundRow;
  }

  // scoring interface, where are we (to the left of) in the divider list?
  // Did we hit one?
  function dividerPick(overCoords, def, marginPx, minVal) {
    const val = def.xScale.invert(overCoords[0]);
    // TODO - careful when we attach uncertainty to dividers.
    const index = d3.bisectLeft(def.dividers, val);
    let hitIndex = index;
    if (index === 0 || index === def.dividers.length) {
      if (index === def.dividers.length) hitIndex = index - 1;
    } else {
      hitIndex = (def.dividers[index] - val < val - def.dividers[index - 1] ? index : index - 1);
    }
    const margin = def.xScale.invert(marginPx) - minVal;
    if (Math.abs(def.dividers[hitIndex] - val) > margin) {
      // we weren't close enough...
      hitIndex = -1;
    }
    return [val, index, hitIndex];
  }
  function scoreRegionPick(overCoords, def, hobj) {
    if (def.dividers.length === 0 || def.regions.length <= 1) return 0;
    const val = def.xScale.invert(overCoords[0]);
    const hitIndex = d3.bisectLeft(def.dividers, val);
    // if (hobj.hmin === def.dividers[0]) hitIndex = hitIndex - 1;
    return hitIndex;
  }

  publicAPI.resize = () => {
    if (model.container === null) return;

    const clientRect = model.container.getBoundingClientRect();
    if (clientRect.width !== 0 && clientRect.height !== 0) {
      model.containerHidden = false;
      publicAPI.render();
    } else {
      model.containerHidden = true;
    }
  };

  publicAPI.render = () => {
    if (model.needData) {
      fetchData();
      return;
    }
    if (model.container === null) return;

    const updateBoxPerRow = updateSizeInformation(model.singleMode);
    if (updateBoxPerRow) {
      // get the data and put it into the nest based on the
      // number of boxesPerRow
      let fieldNames = [];
      // Initialize fields
      if (model.provider.isA('FieldProvider')) {
        fieldNames = model.provider.getFieldNames();
      }
      const mungedData = fieldNames.map(name => {
        const d = model.provider.getField(name);
        if (typeof d.selectedGen === 'undefined') {
          d.selectedGen = 0;
        }
        return d;
      });

      model.nest = mungedData.reduce((prev, item, i) => {
        const group = Math.floor(i / model.boxesPerRow);
        if (prev[group]) {
          prev[group].value.push(item);
        } else {
          prev.push({
            key: group,
            value: [item],
          });
        }
        return prev;
      }, []);
    }

    // resize the div area to be tall enough to hold all our
    // boxes even though most are 'virtual' and lack DOM
    const newHeight = `${Math.ceil(model.nest.length * model.boxHeight)}px`;
    model.parameterList.style('height', newHeight);

    // if we went from less than a page to something that has to scroll
    // then resize again, no clue why
    // if (newHeight > clientHeight && model.lastHeight < clientHeight) {
    //   model.lastHeight = newHeight;
    //   publicAPI.render();
    //   return;
    // }

    if (!model.nest) return;

    // if we've changed view modes, single <==> contact sheet,
    // we need to re-scroll.
    if (model.scrollToName !== null) {
      const topRow = getFieldRow(model.scrollToName);
      model.container.scrollTop = topRow * model.boxHeight;
      model.scrollToName = null;
    }

     // scroll distance, in pixels.
    const scrollY = model.container.scrollTop;
    // convert scroll from pixels to rows, get one row above (-1)
    const offset = Math.max(0, Math.floor(scrollY / model.boxHeight) - 1);

    // extract the visible graphs from the data based on how many rows
    // we have scrolled down plus one above and one below (+2)
    const count = model.rowsPerPage + 2;
    const dataSlice = model.nest.slice(offset, offset + count);

    // attach our slice of data to the rows
    const rows = model.parameterList.selectAll('div')
      .data(dataSlice, (d) => d.key);

    // here is the code that reuses the exit nodes to fill entry
    // nodes. If there are not enough exit nodes then additional ones
    // will be created as needed. The boxes start off as hidden and
    // later have the class removed when their data is ready
    const exitNodes = rows.exit();
    rows.enter().append(() => {
      let reusableNode = 0;
      for (let i = 0; i < exitNodes[0].length; i++) {
        reusableNode = exitNodes[0][i];
        if (reusableNode) {
          exitNodes[0][i] = undefined;
          d3.select(reusableNode)
              .selectAll('table')
              .classed(style.hiddenBox, true);
          return reusableNode;
        }
      }
      return document.createElement('div');
    });
    rows.call(styleRows, model);

    // if there are exit rows remaining that we
    // do not need we can delete them
    rows.exit().remove();

    // now put the data into the boxes
    const boxes = rows.selectAll('table').data((d) => d.value);
    boxes.enter()
      .append('table')
      .classed(style.hiddenBox, true);

    // free up any extra boxes
    boxes.exit().remove();

    // for every item that has data, create all the sub-elements
    // and size them correctly based on our data
    function prepareItem(def, idx) {
      // updateData is called in response to UI events; it tells
      // the dataProvider to update the data to match the UI.
      //
      // updateData must be inside prepareItem() since it uses idx;
      // d3's listener method cannot guarantee the index passed to
      // updateData will be correct:
      function updateData(data) {
        // data.selected = this.checked;
        data.selectedGen++;
        // model.provider.updateField(data.name, { active: data.selected });
        model.provider.toggleFieldSelection(data.name);
      }

      // get existing sub elements
      const ttab = d3.select(this);
      let trow1 = ttab.select(`tr.${style.jsLegendRow}`);
      let trow2 = ttab.select(`tr.${style.jsTr2}`);
      let tdsl = trow2.select(`td.${style.jsSparkline}`);
      let legendCell = trow1.select(`.${style.jsLegend}`);
      let fieldCell = trow1.select(`.${style.jsFieldName}`);
      let svgGr = tdsl.select('svg').select(`.${style.jsGHist}`);
      let svgOverlay = svgGr.select(`.${style.jsOverlay}`);

      // if they are not created yet then create them
      if (trow1.empty()) {
        trow1 = ttab.append('tr').classed(style.legendRow, true)
          .on('click', multiClicker([
            function singleClick(d, i) { // single click handler
              // const overCoords = d3.mouse(model.container);
              updateData(d);
            },
            function doubleClick(d, i) { // double click handler
              model.singleMode = !model.singleMode;
              model.scrollToName = d.name;
              publicAPI.render();

              d3.event.stopPropagation();
            },
          ])
          );
        trow2 = ttab.append('tr').classed(style.jsTr2, true);
        tdsl = trow2.append('td').classed(style.sparkline, true).attr('colspan', '2');
        legendCell = trow1
          .append('td')
          .classed(style.legend, true);

        fieldCell = trow1
          .append('td')
          .classed(style.fieldName, true);

        // Create SVG, and main group created inside the margins for use by axes, title, etc.
        svgGr = tdsl.append('svg').classed(style.sparklineSvg, true)
          .append('g')
            .classed(style.jsGHist, true)
            .attr('transform', `translate( ${model.histMargin.left}, ${model.histMargin.top} )`);
        // nested groups inside main group
        svgGr.append('g')
          .classed(style.axis, true);
        svgGr.append('g')
          .classed(style.jsGRect, true);
        // svgGr.append('g')
        //   .classed(style.brush, true);
        svgGr.append('g')
          .classed(style.score, true);
        svgOverlay = svgGr.append('rect')
          .classed(style.overlay, true)
          .style('cursor', 'default');
      }
      const dataActive = model.provider.getField(def.name).active;
      // Apply legend
      if (model.provider.isA('LegendProvider')) {
        const { color, shape } = model.provider.getLegend(def.name);
        legendCell
          .html(`<svg class='${style.legendSvg}' width='${legendSize}' height='${legendSize}'
                  fill='${color}' stroke='black'><use xlink:href='${shape}'/></svg>`);
      } else {
        legendCell
          .html('<i></i>')
          .select('i');
      }
      trow1
        .classed(!dataActive ? style.selectedLegendRow : style.unselectedLegendRow, false)
        .classed(dataActive ? style.selectedLegendRow : style.unselectedLegendRow, true);
      // selection outline
      ttab
        .classed(style.hiddenBox, false)
        .classed(!dataActive ? style.selectedBox : style.unselectedBox, false)
        .classed(dataActive ? style.selectedBox : style.unselectedBox, true);

      // Apply field name
      fieldCell.text(def.name);

      // adjust some settings based on current size
      tdsl.select('svg')
        .attr('width', svgWidth())
        .attr('height', svgHeight());

      // get the histogram data and rebuild the histogram based on the results
      const hobj = model.provider.getHistogram1D(def.name);
      if (hobj !== null) {
        const cmax = 1.0 * d3.max(hobj.counts);
        const hsize = hobj.counts.length;
        const hdata = svgGr.select(`.${style.jsGRect}`)
          .selectAll(`.${style.jsHistRect}`).data(hobj.counts);

        hdata.enter().append('rect');
        // changes apply to both enter and update data join:
        hdata
          .classed(style.histRect, true)
          .attr('pname', def.name)
          .attr('y', d => model.histHeight * (1.0 - d / cmax))
          .attr('x', (d, i) => (model.histWidth / hsize) * i)
          .attr('height', d => model.histHeight * d / cmax)
          .attr('width', model.histWidth / hsize);

        hdata.exit().remove();
        // svgGr.
        // on('mousemove', (d, i) => {
        //   // console.log('MouseMove!');
        //   if (model.annotationService) {
        //     const mCoords = d3.mouse(svgGr[0][0]);
        //     const binNum = Math.floor((mCoords[0] / model.histWidth) * hsize);
        //     const state = {};
        //     state[def.name] = [binNum];
        //     model.annotationService.setCurrentHover({
        //       source: model.componentId,
        //       state,
        //     });
        //   }
        // }).
        // on('mouseout', (d, i) => {
        //   if (model.annotationService) {
        //     const state = {};
        //     state[def.name] = [-1];
        //     model.annotationService.setCurrentHover({
        //       source: self.componentId,
        //       state,
        //     });
        //   }
        // });

        // Show an x-axis with just min/max displayed.
        // Attach scale, axis and brush objects to this box's
        // data (the 'def' object) to allow persistence when scrolled.
        if (typeof def.xScale === 'undefined') {
          def.xScale = d3.scale.linear();
        }
        def.xScale
          .range([0, model.histWidth])
          .domain([hobj.min, hobj.max]);

        if (typeof def.xAxis === 'undefined') {
          const formatter = d3.format('.3s');
          def.xAxis = d3.svg.axis()
          .tickFormat(formatter)
          .orient('bottom');
        }
        def.xAxis
          .scale(def.xScale)
          .tickValues(def.xScale.domain());

        // nested group for the x-axis min/max display.
        const gAxis = svgGr.select(`.${style.jsAxis}`);
        gAxis
          .attr('transform', `translate(0, ${model.histHeight})`)
          .call(def.xAxis)
          .selectAll('text')
            .classed(style.axisText, true)
            .style('text-anchor', (d, i) => (
              i === 0 ? 'start' : 'end'
            ));
        gAxis.selectAll('line').classed(style.axisLine, true);
        gAxis.selectAll('path').classed(style.axisPath, true);

        const getMouseCoords = () => {
          // y-coordinate is not handled correctly for svg or svgGr or overlay inside scrolling container.
          const coord = d3.mouse(tdsl.node());
          return [coord[0] - model.histMargin.left, coord[1] - model.histMargin.top];
        };

        // scoring interface
        if (typeof model.scores !== 'undefined') {
          if (typeof def.dividers === 'undefined') {
            def.dividers = [];
            def.regions = [model.defaultScore];
            def.editScore = false;
          }

          const gScore = svgGr.select(`.${style.jsScore}`);
          let drag = null;
          if (def.editScore) {
            // add temp dragged divider, if needed.
            const dividerData = ((typeof def.dragDivider !== 'undefined') && def.dragDivider.value !== undefined) ?
                                  def.dividers.concat(def.dragDivider.value) : def.dividers;
            const dividers = gScore.selectAll('line')
              .data(dividerData);
            dividers.enter().append('line');
            dividers
              .attr('x1', d => def.xScale(d))
              .attr('y1', 0)
              .attr('x2', d => def.xScale(d))
              .attr('y2', () => model.histHeight)
              .attr('stroke-width', 1)
              .attr('stroke', 'black');
            dividers.exit().remove();
            // divider interaction events.
            // Drag flow: drag a divider inside its current neighbors.
            // A divider outside its neighbors or a new divider is a temp divider,
            // added to the end of the list when rendering. Doesn't affect regions that way.
            drag = d3.behavior.drag()
              .on('dragstart', (d) => {
                const overCoords = getMouseCoords();
                const [val, , hitIndex] = dividerPick(overCoords, def, model.dragMargin, hobj.min);
                if (d3.event.sourceEvent.altKey || d3.event.sourceEvent.ctrlKey) {
                  // create a temp divider to render.
                  def.dragDivider = { index: -1,
                                      value: val,
                                      low: hobj.min,
                                      high: hobj.max,
                                    };
                  publicAPI.render();
                } else {
                  if (hitIndex >= 0) {
                    // start dragging existing divider
                    // it becomes a temporary copy if we go outside our bounds
                    def.dragDivider = { index: hitIndex,
                                        value: undefined,
                                        low: (hitIndex === 0 ? hobj.min : def.dividers[hitIndex - 1]),
                                        high: (hitIndex === def.dividers.length - 1 ? hobj.max : def.dividers[hitIndex + 1]),
                                      };
                    // console.log('drag start ', hitIndex, def.dragDivider.low, def.dragDivider.high);
                  }
                }
              })
              .on('drag', (d) => {
                const overCoords = getMouseCoords();
                if (typeof def.dragDivider === 'undefined') return;
                const val = def.xScale.invert(overCoords[0]);
                if (def.dragDivider.index >= 0) {
                  // if we drag outside our bounds, make this a 'temporary' extra divider.
                  if (val < def.dragDivider.low) {
                    def.dragDivider.value = val;
                    def.dividers[def.dragDivider.index] = def.dragDivider.low;
                  } else if (val > def.dragDivider.high) {
                    def.dragDivider.value = val;
                    def.dividers[def.dragDivider.index] = def.dragDivider.high;
                  } else {
                    def.dividers[def.dragDivider.index] = val;
                    def.dragDivider.value = undefined;
                  }
                } else {
                  def.dragDivider.value = val;
                }
                publicAPI.render();
              })
              .on('dragend', (d) => {
                if (typeof def.dragDivider === 'undefined') return;
                let val = def.dragDivider.value;
                // if val is defined, we moved an existing divider inside
                // its region, and we just need to render. Otherwise...
                if (val !== undefined) {
                  // drag 30 pixels out of the hist to delete.
                  const dragOut = def.xScale.invert(30) - hobj.min;
                  if (val < hobj.min - dragOut || val > hobj.max + dragOut) {
                    if (def.dragDivider.index >= 0) {
                      // delete a region.
                      if (def.dividers[def.dragDivider.index] === def.dragDivider.low) {
                        def.regions.splice(def.dragDivider.index, 1);
                      } else {
                        def.regions.splice(def.dragDivider.index + 1, 1);
                      }
                      // console.log('del reg ', def.regions);
                      // delete the divider.
                      def.dividers.splice(def.dragDivider.index, 1);
                      // console.log('del div ', def.dividers);
                    }
                  } else {
                    // if we moved a divider, delete the old region
                    if (def.dragDivider.index >= 0) {
                      if (def.dividers[def.dragDivider.index] === def.dragDivider.low) {
                        def.regions.splice(def.dragDivider.index, 1);
                      } else {
                        def.regions.splice(def.dragDivider.index + 1, 1);
                      }
                      // console.log('del reg ', def.regions);
                      // delete the old divider
                      def.dividers.splice(def.dragDivider.index, 1);
                      // console.log('del div ', def.dividers);
                    }
                    // add a new divider
                    val = Math.min(hobj.max, Math.max(hobj.min, val));
                    // TODO - careful when we attach uncertainty to dividers.
                    const index = d3.bisectLeft(def.dividers, val);
                    def.dividers.splice(index, 0, val);
                    // console.log('add div ', index, def.dividers);
                    // add a new region, copies the score of existing region.
                    def.regions.splice(index, 0, def.regions[index]);
                    // console.log('add reg ', index, def.regions);
                  }
                  def.dragDivider = undefined;
                }
                publicAPI.render();
              });
          } else {
            gScore.selectAll('line').remove();
          }

          // score regions
          // there are implicit bounds at the min and max.
          const regionBounds = [hobj.min].concat(def.dividers, hobj.max);
          const scoreRegions = gScore.selectAll('rect')
            .data(def.regions);

          // show the regions when: editing, or when they are non-default. CSS rule makes visible on hover.
          const showScore = def.editScore || (def.regions.length > 1) || (def.regions[0] !== model.defaultScore);
          scoreRegions.enter().append('rect')
            .classed(style.scoreRegion, true);
          scoreRegions
            .attr('x', (d, i) => def.xScale(regionBounds[i]))
            .attr('y', def.editScore ? 0 : model.histHeight)
            // width might be zero if a divider is dragged all the way to min/max.
            .attr('width', (d, i) => def.xScale(regionBounds[i + 1]) - def.xScale(regionBounds[i]))
            .attr('height', def.editScore ? model.histHeight : model.histMargin.bottom)
            .attr('fill', (d) => (model.scores[d].color))
            .attr('opacity', showScore ? '0.2' : '0');
          scoreRegions.exit().remove();

          // invisible overlay to catch mouse events.
          svgOverlay
            .attr('width', model.histWidth)
            .attr('height', model.histHeight + model.histMargin.bottom) // allow clicks inside x-axis.
            .on('click', () => {
              // preventDefault() in dragstart didn't help, so watch for altKey or ctrlKey.
              if (d3.event.defaultPrevented || d3.event.altKey || d3.event.ctrlKey) return; // click suppressed (by drag handling)
              const overCoords = getMouseCoords();
              if (overCoords[1] > model.histHeight) {
                def.editScore = !def.editScore;
                publicAPI.render();
                return;
              }
              if (def.editScore) {
                // if we didn't create or pick a divider, pick a region
                const hitRegionIndex = scoreRegionPick(overCoords, def, hobj);
                def.regions[hitRegionIndex] = (def.regions[hitRegionIndex] + 1) % (model.scores.length);
                publicAPI.render();
              }
            })
            .on('mousemove', () => {
              const overCoords = getMouseCoords();
              if (def.editScore) {
                const [, , hitIndex] = dividerPick(overCoords, def, model.dragMargin, hobj.min);
                const moveIt = (def.dragIndex >= 0) || (hitIndex >= 0);
                svgOverlay.style('cursor', moveIt ? 'ew-resize' : 'crosshair');
              } else {
                const pickIt = overCoords[1] > model.histHeight;
                svgOverlay.style('cursor', pickIt ? 'crosshair' : 'default');
              }
            });
          if (def.editScore) {
            svgOverlay.call(drag);
          } else {
            svgOverlay.on('.drag', null);
          }
        }
      }
    }

    // make sure all the elements are created
    // and updated
    boxes.each(prepareItem);
    boxes
      .call(styleBoxes, model);
  };

  publicAPI.setContainer = (element) => {
    if (model.container) {
      while (model.container.firstChild) {
        model.container.removeChild(model.container.firstChild);
      }
      model.container = null;
    }

    model.container = element;

    if (model.container !== null) {
      model.parameterList = d3.select(model.container)
        .append('div')
        .classed(style.histogramSelector, true);
      d3.select(model.container)
        .style('overflow-y', 'auto')
        .style('overflow-x', 'hidden')
        .on('scroll', () => { publicAPI.render(); });
      publicAPI.resize();
    }
  };

  model.subscriptions.push({ unsubscribe: publicAPI.setContainer });
  // event from the FieldProvider
  // TODO overkill if one field's 'active' flag changes.
  model.subscriptions.push(model.provider.onFieldChange(fetchData));
  // event from Histogram Provider
  model.subscriptions.push(model.provider.onHistogram1DReady(publicAPI.render));

  // Make sure default values get applied
  publicAPI.setContainer(model.container);
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {
  container: null,
  provider: null,
  needData: true,
  containerHidden: false,

  displayUnselected: true,
  parameterList: null,
  nest: null, // nested aray of data nest[rows][boxes]
  boxesPerRow: 0,
  rowsPerPage: 0,
  boxWidth: 120,
  boxHeight: 120,
  // show 1 per row?
  singleMode: false,
  scrollToName: null,
  // margins inside the SVG element.
  histMargin: { top: 3, right: 3, bottom: 18, left: 3 },
  histWidth: 90,
  histHeight: 70,
  lastHeight: 0,
  lastOffset: -1,
  // scoring interface activated by passing in 'scores' array externally.
  // scores: [{ name: 'Yes', color: '#00C900' }, ... ],
  defaultScore: 0,
  dragMargin: 8,
};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  CompositeClosureHelper.destroy(publicAPI, model);
  CompositeClosureHelper.isA(publicAPI, model, 'VizComponent');
  CompositeClosureHelper.get(publicAPI, model, ['provider', 'container']);

  histogramSelector(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = CompositeClosureHelper.newInstance(extend);

// ----------------------------------------------------------------------------

export default { newInstance, extend };