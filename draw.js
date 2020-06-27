/* jslint esversion: 6 */

/*
 * Copyright 2019 Abakkk
 *
 * This file is part of DrawOnYourScreen, a drawing extension for GNOME Shell.
 * https://framagit.org/abakkk/DrawOnYourScreen
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const ByteArray = imports.byteArray;
const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;
const St = imports.gi.St;

const BoxPointer = imports.ui.boxpointer;
const Config = imports.misc.config;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const Screenshot = imports.ui.screenshot;
const Tweener = imports.ui.tweener;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = ExtensionUtils.getSettings ? ExtensionUtils : Me.imports.convenience;
const Extension = Me.imports.extension;
const Prefs = Me.imports.prefs;
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;

const GS_VERSION = Config.PACKAGE_VERSION;
const CAIRO_DEBUG_EXTENDS = false;
const SVG_DEBUG_EXTENDS = false;
const SVG_DEBUG_SUPERPOSES_CAIRO = false;
const TEXT_CURSOR_TIME = 600; // ms

const ICON_DIR = Me.dir.get_child('data').get_child('icons');
const COLOR_ICON_PATH = ICON_DIR.get_child('color-symbolic.svg').get_path();
const FILL_ICON_PATH = ICON_DIR.get_child('fill-symbolic.svg').get_path();
const STROKE_ICON_PATH = ICON_DIR.get_child('stroke-symbolic.svg').get_path();
const LINEJOIN_ICON_PATH = ICON_DIR.get_child('linejoin-symbolic.svg').get_path();
const LINECAP_ICON_PATH = ICON_DIR.get_child('linecap-symbolic.svg').get_path();
const FILLRULE_NONZERO_ICON_PATH = ICON_DIR.get_child('fillrule-nonzero-symbolic.svg').get_path();
const FILLRULE_EVENODD_ICON_PATH = ICON_DIR.get_child('fillrule-evenodd-symbolic.svg').get_path();
const DASHED_LINE_ICON_PATH = ICON_DIR.get_child('dashed-line-symbolic.svg').get_path();
const FULL_LINE_ICON_PATH = ICON_DIR.get_child('full-line-symbolic.svg').get_path();

const reverseEnumeration = function(obj) {
    return Object.fromEntries(Object.entries(obj).map(entry => 
        [entry[1], entry[0].slice(0,1) + entry[0].slice(1).toLowerCase().replace('_', '-')]
    ));
};

const Shapes = { NONE: 0, LINE: 1, ELLIPSE: 2, RECTANGLE: 3, TEXT: 4, POLYGON: 5, POLYLINE: 6 };
const Manipulations = { MOVE: 100, RESIZE: 101, MIRROR: 102 };
var   Tools = Object.assign({}, Shapes, Manipulations);
const Transformations = { TRANSLATION: 0, ROTATION: 1, SCALE_PRESERVE: 2, STRETCH: 3, REFLECTION: 4, INVERSION: 5 };
const ToolNames = { 0: "Free drawing", 1: "Line", 2: "Ellipse", 3: "Rectangle", 4: "Text", 5: "Polygon", 6: "Polyline", 100: "Move", 101: "Resize", 102: "Mirror" };
const LineCapNames = Object.assign(reverseEnumeration(Cairo.LineCap), { 2: 'Square' });
const LineJoinNames = reverseEnumeration(Cairo.LineJoin);
const FillRuleNames = { 0: 'Nonzero', 1: 'Evenodd' };
const FontGenericNames = {  0: 'Theme', 1: 'Sans-Serif', 2: 'Serif', 3: 'Monospace', 4: 'Cursive', 5: 'Fantasy' };
const FontWeightNames = Object.assign(reverseEnumeration(Pango.Weight), { 200: "Ultra-light", 350: "Semi-light", 600: "Semi-bold", 800: "Ultra-bold" });
delete FontWeightNames[Pango.Weight.ULTRAHEAVY];
const FontStyleNames = reverseEnumeration(Pango.Style);
const FontStretchNames = reverseEnumeration(Pango.Stretch);
const FontVariantNames = reverseEnumeration(Pango.Variant);

const getDateString = function() {
    let date = GLib.DateTime.new_now_local();
    return `${date.format("%F")} ${date.format("%X")}`;
};

const getJsonFiles = function() {
    let directory = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), Me.metadata['data-dir']]));
    
    let enumerator;
    try {
        enumerator = directory.enumerate_children('standard::name,standard::display-name,standard::content-type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
    } catch(e) {
        return [];
    }
    
    let jsonFiles = [];
    let fileInfo = enumerator.next_file(null);
    while (fileInfo) {
        if (fileInfo.get_content_type().indexOf('json') != -1 && fileInfo.get_name() != `${Me.metadata['persistent-file-name']}.json`) {
            let file = enumerator.get_child(fileInfo);
            jsonFiles.push({ name: fileInfo.get_name().slice(0, -5),
                             displayName: fileInfo.get_display_name().slice(0, -5),
                             // fileInfo.get_modification_date_time: Gio 2.62+
                             modificationUnixTime: fileInfo.get_attribute_uint64('time::modified'),
                             delete: () => file.delete(null) });
        }
        fileInfo = enumerator.next_file(null);
    }
    enumerator.close(null);
    
    jsonFiles.sort((a, b) => {
        return b.modificationUnixTime - a.modificationUnixTime;
    });
    
    return jsonFiles;
};

// DrawingArea is the widget in which we draw, thanks to Cairo.
// It creates and manages a DrawingElement for each "brushstroke".
// It handles pointer/mouse/(touch?) events and some keyboard events.
var DrawingArea = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingArea',
    Extends: St.DrawingArea,
    Signals: { 'show-osd': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_DOUBLE] },
               'update-action-mode': {},
               'leave-drawing-mode': {} },

    _init: function(params, monitor, helper, loadPersistent) {
        this.parent({ style_class: 'draw-on-your-screen', name: params.name});
        
        this.connect('destroy', this._onDestroy.bind(this));
        this.reactiveHandler = this.connect('notify::reactive', this._onReactiveChanged.bind(this));
        
        this.settings = Convenience.getSettings();
        this.monitor = monitor;
        this.helper = helper;
        
        this.elements = [];
        this.undoneElements = [];
        this.currentElement = null;
        this.currentTool = Shapes.NONE;
        this.currentFontGeneric = 0;
        this.isSquareArea = false;
        this.hasGrid = false;
        this.hasBackground = false;
        this.textHasCursor = false;
        this.dashedLine = false;
        this.fill = false;
        this.colors = [Clutter.Color.new(0, 0, 0, 255)];
        this.newThemeAttributes = {};
        this.oldThemeAttributes = {};
        
        if (loadPersistent)
            this._loadPersistent();
    },
    
    get menu() {
        if (!this._menu)
            this._menu = new DrawingMenu(this, this.monitor);
        return this._menu;
    },
    
    closeMenu: function() {
        if (this._menu)
            this._menu.close();
    },
    
    get isWriting() {
        return this.textEntry ? true : false;
    },
    
    get currentTool() {
        return this._currentTool;
    },
    
    set currentTool(tool) {
        this._currentTool = tool;
        if (Object.values(Manipulations).indexOf(tool) != -1)
            this._startElementGrabber();
        else
            this._stopElementGrabber();
    },
    
    // Boolean wrapper for switch menu item.
    get currentEvenodd() {
        return this.currentFillRule == Cairo.FillRule.EVEN_ODD;
    },
    
    set currentEvenodd(evenodd) {
        this.currentFillRule = evenodd ? Cairo.FillRule.EVEN_ODD : Cairo.FillRule.WINDING;
    },
    
    vfunc_repaint: function() {
        let cr = this.get_context();
        
        try {
            this._repaint(cr);
        } catch(e) {
            logError(e, "An error occured while painting");
        }
        
        cr.$dispose();
    },
    
    _redisplay: function() {
        // force area to emit 'repaint'
        this.queue_repaint();
    },
    
    _updateStyle: function() {
        try {
            let themeNode = this.get_theme_node();
            for (let i = 1; i < 10; i++) {
                this.colors[i] = themeNode.get_color('-drawing-color' + i);
            }
            let font = themeNode.get_font();
            this.newThemeAttributes.ThemeFontFamily = font.get_family();
            try { this.newThemeAttributes.FontWeight = font.get_weight(); } catch(e) { this.newThemeAttributes.FontWeight = Pango.Weight.NORMAL; }
            this.newThemeAttributes.FontStyle = font.get_style();
            this.newThemeAttributes.FontStretch = font.get_stretch();
            this.newThemeAttributes.FontVariant = font.get_variant();
            this.newThemeAttributes.TextRightAligned = themeNode.get_text_align() == St.TextAlign.RIGHT;
            this.newThemeAttributes.LineWidth = themeNode.get_length('-drawing-line-width');
            this.newThemeAttributes.LineJoin = themeNode.get_double('-drawing-line-join');
            this.newThemeAttributes.LineCap = themeNode.get_double('-drawing-line-cap');
            this.newThemeAttributes.FillRule = themeNode.get_double('-drawing-fill-rule');
            this.dashArray = [Math.abs(themeNode.get_length('-drawing-dash-array-on')), Math.abs(themeNode.get_length('-drawing-dash-array-off'))];
            this.dashOffset = themeNode.get_length('-drawing-dash-offset');
            this.gridGap = themeNode.get_length('-grid-overlay-gap');
            this.gridLineWidth = themeNode.get_length('-grid-overlay-line-width');
            this.gridInterlineWidth = themeNode.get_length('-grid-overlay-interline-width');
            this.gridColor = themeNode.get_color('-grid-overlay-color');
            this.squareAreaWidth = themeNode.get_length('-drawing-square-area-width');
            this.squareAreaHeight = themeNode.get_length('-drawing-square-area-height');
            this.activeBackgroundColor = themeNode.get_color('-drawing-background-color');
        } catch(e) {
            logError(e);
        }
        
        for (let i = 1; i < 10; i++) {
            this.colors[i] = this.colors[i].alpha ? this.colors[i] : this.colors[0];
        }
        this.currentColor = this.currentColor || this.colors[1];
        // SVG does not support 'Ultra-heavy' weight (1000)
        this.newThemeAttributes.FontWeight = Math.min(this.newThemeAttributes.FontWeight, 900);
        this.newThemeAttributes.LineWidth = (this.newThemeAttributes.LineWidth > 0) ? this.newThemeAttributes.LineWidth : 3;
        this.newThemeAttributes.LineJoin = ([0, 1, 2].indexOf(this.newThemeAttributes.LineJoin) != -1) ? this.newThemeAttributes.LineJoin : Cairo.LineJoin.ROUND;
        this.newThemeAttributes.LineCap = ([0, 1, 2].indexOf(this.newThemeAttributes.LineCap) != -1) ? this.newThemeAttributes.LineCap : Cairo.LineCap.ROUND;
        this.newThemeAttributes.FillRule = ([0, 1].indexOf(this.newThemeAttributes.FillRule) != -1) ? this.newThemeAttributes.FillRule : Cairo.FillRule.WINDING;
        for (const attributeName in this.newThemeAttributes) {
            if (this.newThemeAttributes[attributeName] != this.oldThemeAttributes[attributeName]) {
                this.oldThemeAttributes[attributeName] = this.newThemeAttributes[attributeName];
                this[`current${attributeName}`] = this.newThemeAttributes[attributeName];
            }
        }
        this.gridGap = this.gridGap && this.gridGap >= 1 ? this.gridGap : 10;
        this.gridLineWidth = this.gridLineWidth || 0.4;
        this.gridInterlineWidth = this.gridInterlineWidth || 0.2;
        this.gridColor = this.gridColor && this.gridColor.alpha ? this.gridColor : Clutter.Color.new(127, 127, 127, 255);
    },
    
    _repaint: function(cr) {
        if (CAIRO_DEBUG_EXTENDS) {
            cr.scale(0.5, 0.5);
            cr.translate(this.monitor.width, this.monitor.height);
        }
        
        for (let i = 0; i < this.elements.length; i++) {
            cr.save();
            
            this.elements[i].buildCairo(cr, { showTextRectangle: this.grabbedElement && this.grabbedElement == this.elements[i],
                                              drawTextRectangle: this.grabPoint ? true : false });
            
            if (this.grabPoint)
                this._searchElementToGrab(cr, this.elements[i]);
            
            if (this.elements[i].fill && !this.elements[i].isStraightLine) {
                cr.fillPreserve();
                if (this.elements[i].shape == Shapes.NONE || this.elements[i].shape == Shapes.LINE)
                    cr.closePath();
            } 
            
            cr.stroke();
            cr.restore();
        }
        
        if (this.currentElement) {
            cr.save();
            this.currentElement.buildCairo(cr, { showTextCursor: this.textHasCursor,
                                                 showTextRectangle: this.currentElement.shape == Shapes.TEXT && !this.isWriting,
                                                 dummyStroke: this.currentElement.fill && this.currentElement.line.lineWidth == 0 });
            
            cr.stroke();
            cr.restore();
        }
        
        if (this.reactive && this.hasGrid && this.gridGap && this.gridGap >= 1) {
            cr.save();
            Clutter.cairo_set_source_color(cr, this.gridColor);
            
            let [gridX, gridY] = [this.gridGap, this.gridGap];
            while (gridX < this.monitor.width) {
                cr.setLineWidth((gridX / this.gridGap) % 5 ? this.gridInterlineWidth : this.gridLineWidth);
                cr.moveTo(gridX, 0);
                cr.lineTo(gridX, this.monitor.height);
                gridX += this.gridGap;
                cr.stroke();
            }
            while (gridY < this.monitor.height) {
                cr.setLineWidth((gridY / this.gridGap) % 5 ? this.gridInterlineWidth : this.gridLineWidth);
                cr.moveTo(0, gridY);
                cr.lineTo(this.monitor.width, gridY);
                gridY += this.gridGap;
                cr.stroke();
            }
            cr.restore();
        }
    },
    
    _onButtonPressed: function(actor, event) {
        if (this.spaceKeyPressed)
            return Clutter.EVENT_PROPAGATE;
        
        let button = event.get_button();
        let [x, y] = event.get_coords();
        let controlPressed = event.has_control_modifier();
        let shiftPressed = event.has_shift_modifier();
        
        if (this.currentElement && this.currentElement.shape == Shapes.TEXT && this.isWriting)
            // finish writing
            this._stopWriting();
        
        if (this.helper.visible) {
            // hide helper
            this.toggleHelp();
            return Clutter.EVENT_STOP;
        }
        
        if (button == 1) {
            if (Object.values(Manipulations).indexOf(this.currentTool) != -1) {
                if (this.grabbedElement)
                    this._startTransforming(x, y, controlPressed, shiftPressed);
            } else {
                this._startDrawing(x, y, shiftPressed);
            }
            return Clutter.EVENT_STOP;
        } else if (button == 2) {
            this.toggleFill();
        } else if (button == 3) {
            this._stopDrawing();
            this.menu.open(x, y);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },
    
    _onKeyboardPopupMenu: function() {
        this._stopDrawing();
        if (this.helper.visible)
            this.toggleHelp();
        this.menu.popup();
        return Clutter.EVENT_STOP;
    },
    
    _onStageKeyPressed: function(actor, event) {
        if (event.get_key_symbol() == Clutter.KEY_space)
            this.spaceKeyPressed = true;
        
        return Clutter.EVENT_PROPAGATE;
    },
    
    _onStageKeyReleased: function(actor, event) {
        if (event.get_key_symbol() == Clutter.KEY_space)
            this.spaceKeyPressed = false;
        
        return Clutter.EVENT_PROPAGATE;
    },
    
    _onKeyPressed: function(actor, event) {
        if (this.currentElement && this.currentElement.shape == Shapes.LINE) {
            if (event.get_key_symbol() == Clutter.KEY_Return ||
                event.get_key_symbol() == Clutter.KEY_KP_Enter ||
                event.get_key_symbol() == Clutter.KEY_Control_L) {
                if (this.currentElement.points.length == 2)
                    this.emit('show-osd', null, _("Press <i>%s</i> to get a fourth control point")
                                                .format(Gtk.accelerator_get_label(Clutter.KEY_Return, 0)), "", -1);
                this.currentElement.addPoint();
                this.updatePointerCursor(true);
                this._redisplay();
                return Clutter.EVENT_STOP;
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
        
        } else if (this.currentElement &&
                   (this.currentElement.shape == Shapes.POLYGON || this.currentElement.shape == Shapes.POLYLINE) &&
                   (event.get_key_symbol() == Clutter.KEY_Return || event.get_key_symbol() == Clutter.KEY_KP_Enter)) {
            this.currentElement.addPoint();
            return Clutter.EVENT_STOP;
            
        } else if (event.get_key_symbol() == Clutter.KEY_Escape) {
            if (this.helper.visible)
                this.toggleHelp();
            else
                this.emit('leave-drawing-mode');
            return Clutter.EVENT_STOP;
            
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
    },
    
    _onScroll: function(actor, event) {
        if (this.helper.visible)
            return Clutter.EVENT_PROPAGATE;
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP)
             this.incrementLineWidth(1);
        else if (direction == Clutter.ScrollDirection.DOWN)
            this.incrementLineWidth(-1);
        else
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    },
    
    _searchElementToGrab: function(cr, element) {
        if (element.getContainsPoint(cr, this.grabPoint[0], this.grabPoint[1]))
            this.grabbedElement = element;
        else if (this.grabbedElement == element)
            this.grabbedElement = null;
        
        if (element == this.elements[this.elements.length - 1])
            // All elements have been tested, the winner is the last.
            this.updatePointerCursor();
    },
    
    _startElementGrabber: function() {
        this.elementGrabberHandler = this.connect('motion-event', (actor, event) => {
            if (this.motionHandler || this.grabbedElementLocked) {
                this.grabPoint = null;
                return;
            }
            
            // Reduce computing without notable effect.
            if (Math.random() <= 0.75)
                return;
            
            let coords = event.get_coords();
            let [s, x, y] = this.transform_stage_point(coords[0], coords[1]);
            if (!s)
                return;
            
            this.grabPoint = [x, y];
            this.grabbedElement = null;
            // this._redisplay calls this._searchElementToGrab.
            this._redisplay();
        });
    },
    
    _stopElementGrabber: function() {
        if (this.elementGrabberHandler) {
            this.disconnect(this.elementGrabberHandler);
            this.grabPoint = null;
            this.elementGrabberHandler = null;
        }
    },
    
    _startTransforming: function(stageX, stageY, controlPressed, duplicate) {
        let [success, startX, startY] = this.transform_stage_point(stageX, stageY);
        
        if (!success)
            return;
        
        if (this.currentTool == Manipulations.MIRROR) {
            this.grabbedElementLocked = !this.grabbedElementLocked;
            if (this.grabbedElementLocked) {
                this.updatePointerCursor();
                let label = controlPressed ? _("Mark a point of symmetry") : _("Draw a line of symmetry");
                this.emit('show-osd', null, label, "", -1);
                return;
            }
        }
        
        this.grabPoint = null;
        
        this.buttonReleasedHandler = this.connect('button-release-event', (actor, event) => {
            this._stopTransforming();
        });
        
        if (duplicate) {
            // deep cloning
            let copy = new DrawingElement(JSON.parse(JSON.stringify(this.grabbedElement)));
            this.elements.push(copy);
            this.grabbedElement = copy;
        }
        
        if (this.currentTool == Manipulations.MOVE)
            this.grabbedElement.startTransformation(startX, startY, controlPressed ? Transformations.ROTATION : Transformations.TRANSLATION);
        else if (this.currentTool == Manipulations.RESIZE)
            this.grabbedElement.startTransformation(startX, startY, controlPressed ? Transformations.STRETCH : Transformations.SCALE_PRESERVE);
         else if (this.currentTool == Manipulations.MIRROR) {
            this.grabbedElement.startTransformation(startX, startY, controlPressed ? Transformations.INVERSION : Transformations.REFLECTION);
            this._redisplay();
        }
        
        
        this.motionHandler = this.connect('motion-event', (actor, event) => {
            if (this.spaceKeyPressed)
                return;
            
            let coords = event.get_coords();
            let [s, x, y] = this.transform_stage_point(coords[0], coords[1]);
            if (!s)
                return;
            let controlPressed = event.has_control_modifier();
            this._updateTransforming(x, y, controlPressed);
        });
    },
    
    _updateTransforming: function(x, y, controlPressed) {
        if (controlPressed && this.grabbedElement.lastTransformation.type == Transformations.TRANSLATION) {
            this.grabbedElement.stopTransformation();
            this.grabbedElement.startTransformation(x, y, Transformations.ROTATION);
        } else if (!controlPressed && this.grabbedElement.lastTransformation.type == Transformations.ROTATION) {
            this.grabbedElement.stopTransformation();
            this.grabbedElement.startTransformation(x, y, Transformations.TRANSLATION);
        }
        
        if (controlPressed && this.grabbedElement.lastTransformation.type == Transformations.SCALE_PRESERVE) {
            this.grabbedElement.stopTransformation();
            this.grabbedElement.startTransformation(x, y, Transformations.STRETCH);
        } else if (!controlPressed && this.grabbedElement.lastTransformation.type == Transformations.STRETCH) {
            this.grabbedElement.stopTransformation();
            this.grabbedElement.startTransformation(x, y, Transformations.SCALE_PRESERVE);
        }
        
        if (controlPressed && this.grabbedElement.lastTransformation.type == Transformations.REFLECTION) {
            this.grabbedElement.transformations.pop();
            this.grabbedElement.startTransformation(x, y, Transformations.INVERSION);
        } else if (!controlPressed && this.grabbedElement.lastTransformation.type == Transformations.INVERSION) {
            this.grabbedElement.transformations.pop();
            this.grabbedElement.startTransformation(x, y, Transformations.REFLECTION);
        }
        
        this.grabbedElement.updateTransformation(x, y);
        this._redisplay();
    },
    
    _stopTransforming: function() {
        if (this.motionHandler) {
            this.disconnect(this.motionHandler);
            this.motionHandler = null;
        }
        if (this.buttonReleasedHandler) {
            this.disconnect(this.buttonReleasedHandler);
            this.buttonReleasedHandler = null;
        }
        
        this.grabbedElement.stopTransformation();
        this.grabbedElement = null;
        this.grabbedElementLocked = false;
        this._redisplay();
    },
    
    _startDrawing: function(stageX, stageY, eraser) {
        let [success, startX, startY] = this.transform_stage_point(stageX, stageY);
        
        if (!success)
            return;
        
        this.buttonReleasedHandler = this.connect('button-release-event', (actor, event) => {
            this._stopDrawing();
        });
        
        this.currentElement = new DrawingElement ({
            shape: this.currentTool,
            color: this.currentColor.to_string(),
            line: { lineWidth: this.currentLineWidth, lineJoin: this.currentLineJoin, lineCap: this.currentLineCap },
            dash: { active: this.dashedLine, array: this.dashedLine ? [this.dashArray[0] || this.currentLineWidth, this.dashArray[1] || this.currentLineWidth * 3] : [0, 0] , offset: this.dashOffset },
            fill: this.fill,
            fillRule: this.currentFillRule,
            eraser: eraser,
            transform: { active: false, center: [0, 0], angle: 0, startAngle: 0, ratio: 1 },
            points: []
        });
        
        if (this.currentTool == Shapes.TEXT) {
            this.currentElement.fill = false;
            this.currentElement.font = {
                family: (this.currentFontGeneric == 0 ? this.currentThemeFontFamily : FontGenericNames[this.currentFontGeneric]),
                weight: this.currentFontWeight,
                style: this.currentFontStyle,
                stretch: this.currentFontStretch,
                variant: this.currentFontVariant };
            this.currentElement.text = _("Text");
            this.currentElement.textRightAligned = this.currentTextRightAligned;
        }
        
        this.currentElement.startDrawing(startX, startY);
        
        if (this.currentTool == Shapes.POLYGON || this.currentTool == Shapes.POLYLINE)
            this.emit('show-osd', null, _("Press <i>%s</i> to mark vertices").format(Gtk.accelerator_get_label(Clutter.KEY_Return, 0)), "", -1);
        
        this.motionHandler = this.connect('motion-event', (actor, event) => {
            if (this.spaceKeyPressed)
                return;
            
            let coords = event.get_coords();
            let [s, x, y] = this.transform_stage_point(coords[0], coords[1]);
            if (!s)
                return;
            let controlPressed = event.has_control_modifier();
            this._updateDrawing(x, y, controlPressed);
        });
    },
    
    _updateDrawing: function(x, y, controlPressed) {
        if (!this.currentElement)
            return;
        
        this.currentElement.updateDrawing(x, y, controlPressed);
        
        this._redisplay();
        this.updatePointerCursor(controlPressed);
    },
    
    _stopDrawing: function() {
        if (this.motionHandler) {
            this.disconnect(this.motionHandler);
            this.motionHandler = null;
        }
        if (this.buttonReleasedHandler) {
            this.disconnect(this.buttonReleasedHandler);
            this.buttonReleasedHandler = null;
        }
        
        // skip when a polygon has not at least 3 points
        if (this.currentElement && this.currentElement.shape == Shapes.POLYGON && this.currentElement.points.length < 3)
            this.currentElement = null;
        
        if (this.currentElement)
            this.currentElement.stopDrawing();
        
        if (this.currentElement && this.currentElement.points.length >= 2) {
            if (this.currentElement.shape == Shapes.TEXT && !this.isWriting) {
                this._startWriting();
                return;
            }
        
            this.elements.push(this.currentElement);
        }
        
        this.currentElement = null;
        this._redisplay();
        this.updatePointerCursor();
    },
    
    _startWriting: function() {
        this.currentElement.text = '';
        this.currentElement.cursorPosition = 0;
        this.emit('show-osd', null, _("Type your text and press <i>%s</i>").format(Gtk.accelerator_get_label(Clutter.KEY_Escape, 0)), "", -1);
        this._updateTextCursorTimeout();
        this.textHasCursor = true;
        this._redisplay();
        this.updatePointerCursor();
        
        this.textEntry = new St.Entry({ visible: false });
        this.get_parent().add_child(this.textEntry);
        this.textEntry.grab_key_focus();
        this.updateActionMode();
        
        this.textEntry.clutterText.connect('activate', (clutterText) => {
            let startNewLine = true;
            this._stopWriting(startNewLine);
            clutterText.text = "";
        });
        
        this.textEntry.clutterText.connect('text-changed', (clutterText) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.currentElement.text = clutterText.text;
                this.currentElement.cursorPosition = clutterText.cursorPosition;
                this._updateTextCursorTimeout();
                this._redisplay();
            });
        });
        
        this.textEntry.clutterText.connect('key-press-event', (clutterText, event) => {
            if (event.get_key_symbol() == Clutter.KEY_Escape) {
                this._stopWriting();
                return Clutter.EVENT_STOP;
            }
            
            // 'cursor-changed' signal is not emitted if the text entry is not visible.
            // So key events related to the cursor must be listened.
            if (event.get_key_symbol() == Clutter.KEY_Left || event.get_key_symbol() == Clutter.KEY_Right ||
                event.get_key_symbol() == Clutter.KEY_Home || event.get_key_symbol() == Clutter.KEY_End) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this.currentElement.cursorPosition = clutterText.cursorPosition;
                    this._updateTextCursorTimeout();
                    this.textHasCursor = true;
                    this._redisplay();
                });
            }
            
            return Clutter.EVENT_PROPAGATE;
        });
    },
    
    _stopWriting: function(startNewLine) {
        if (this.currentElement.text.length > 0)
            this.elements.push(this.currentElement);
            
        if (startNewLine && this.currentElement.points.length == 2) {
            this.currentElement.lineIndex = this.currentElement.lineIndex || 0;
            // copy object, the original keep existing in this.elements
            this.currentElement = Object.create(this.currentElement);
            this.currentElement.lineIndex ++;
            let height = Math.abs(this.currentElement.points[1][1] - this.currentElement.points[0][1]);
            // define a new 'points' array, the original keep existing in this.elements
            this.currentElement.points = [
                [this.currentElement.points[0][0], this.currentElement.points[0][1] + height],
                [this.currentElement.points[1][0], this.currentElement.points[1][1] + height]
            ];
            this.currentElement.text = "";
        } else {
            this.currentElement = null;
            this._stopTextCursorTimeout();
            this.textEntry.destroy();
            delete this.textEntry;
            this.grab_key_focus();
            this.updateActionMode();
        }
        
        this._redisplay();
    },
    
    setPointerCursor: function(pointerCursorName) {
        if (!this.currentPointerCursorName || this.currentPointerCursorName != pointerCursorName) {
            this.currentPointerCursorName = pointerCursorName;
            Extension.setCursor(pointerCursorName);
        }
    },
    
    updatePointerCursor: function(controlPressed) {
        if (this.currentTool == Manipulations.MIRROR && this.grabbedElementLocked)
            this.setPointerCursor('CROSSHAIR');
        else if (Object.values(Manipulations).indexOf(this.currentTool) != -1)
            this.setPointerCursor(this.grabbedElement ? 'MOVE_OR_RESIZE_WINDOW' : 'DEFAULT');
        else if (!this.currentElement || (this.currentElement.shape == Shapes.TEXT && this.isWriting))
            this.setPointerCursor(this.currentTool == Shapes.NONE ? 'POINTING_HAND' : 'CROSSHAIR');
        else if (this.currentElement.shape != Shapes.NONE && controlPressed)
            this.setPointerCursor('MOVE_OR_RESIZE_WINDOW');
    },
    
    initPointerCursor: function() {
        this.currentPointerCursorName = null;
        this.updatePointerCursor();
    },
    
    _stopTextCursorTimeout: function() {
        if (this.textCursorTimeoutId) {
            GLib.source_remove(this.textCursorTimeoutId);
            this.textCursorTimeoutId = null;
        }
        this.textHasCursor = false;
    },
    
    _updateTextCursorTimeout: function() {
        this._stopTextCursorTimeout();
        this.textCursorTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TEXT_CURSOR_TIME, () => {
            this.textHasCursor = !this.textHasCursor;
            this._redisplay();
            return GLib.SOURCE_CONTINUE;
        });
    },
    
    erase: function() {
        this.deleteLastElement();
        this.elements = [];
        this.undoneElements = [];
        this._redisplay();
    },
    
    deleteLastElement: function() {
        if (this.currentElement) {
            if (this.motionHandler) {
                this.disconnect(this.motionHandler);
                this.motionHandler = null;
            }
            if (this.buttonReleasedHandler) {
                this.disconnect(this.buttonReleasedHandler);
                this.buttonReleasedHandler = null;
            }
            if (this.isWriting)
                this._stopWriting();
            this.currentElement = null;
        } else {
            this.elements.pop();
        }
        this._redisplay();
    },
    
    undo: function() {
        if (this.elements.length > 0)
            this.undoneElements.push(this.elements.pop());
        this._redisplay();
    },
    
    redo: function() {
        if (this.undoneElements.length > 0)
            this.elements.push(this.undoneElements.pop());
        this._redisplay();
    },
    
    smoothLastElement: function() {
        if (this.elements.length > 0 && this.elements[this.elements.length - 1].shape == Shapes.NONE) {
            this.elements[this.elements.length - 1].smoothAll();
            this._redisplay();
        }
    },
    
    toggleBackground: function() {
        this.hasBackground = !this.hasBackground;
        this.get_parent().set_background_color(this.hasBackground ? this.activeBackgroundColor : null);
    },
    
    toggleGrid: function() {
        this.hasGrid = !this.hasGrid;
        this._redisplay();
    },
    
    toggleSquareArea: function() {
        this.isSquareArea = !this.isSquareArea;
        if (this.isSquareArea) {
            let width = this.squareAreaWidth || this.squareAreaHeight || Math.min(this.monitor.width, this.monitor.height) * 3 / 4;
            let height = this.squareAreaHeight || this.squareAreaWidth || Math.min(this.monitor.width, this.monitor.height) * 3 / 4;
            this.set_position(Math.floor(this.monitor.width / 2 - width / 2), Math.floor(this.monitor.height / 2 - height / 2));
            this.set_size(width, height);
            this.add_style_class_name('draw-on-your-screen-square-area');
        } else {
            this.set_position(0, 0);
            this.set_size(this.monitor.width, this.monitor.height);
            this.remove_style_class_name('draw-on-your-screen-square-area');
        }
    },
    
    toggleColor: function() {
        this.selectColor((this.currentColor == this.colors[1]) ? 2 : 1);
    },
    
    selectColor: function(index) {
        this.currentColor = this.colors[index];
        if (this.currentElement) {
            this.currentElement.color = this.currentColor.to_string();
            this._redisplay();
        }
        // Foreground color markup is not displayed since 3.36, use style instead but the transparency is lost.
        this.emit('show-osd', null, this.currentColor.to_string(), this.currentColor.to_string().slice(0, 7), -1);
    },
    
    selectTool: function(tool) {
        this.currentTool = tool;
        this.emit('show-osd', null, _(ToolNames[tool]), "", -1);
        this.updatePointerCursor();
    },
    
    toggleFill: function() {
        this.fill = !this.fill;
        this.emit('show-osd', null, this.fill ? _("Fill") : _("Stroke"), "", -1);
    },
    
    toggleDash: function() {
        this.dashedLine = !this.dashedLine;
        this.emit('show-osd', null, this.dashedLine ? _("Dashed line") : _("Full line"), "", -1);
    },
    
    incrementLineWidth: function(increment) {
        this.currentLineWidth = Math.max(this.currentLineWidth + increment, 0);
        this.emit('show-osd', null, _("%d px").format(this.currentLineWidth), "", 2 * this.currentLineWidth);
    },
    
    toggleLineJoin: function() {
        this.currentLineJoin = this.currentLineJoin == 2 ? 0 : this.currentLineJoin + 1;
        this.emit('show-osd', null, _(LineJoinNames[this.currentLineJoin]), "", -1);
    },
    
    toggleLineCap: function() {
        this.currentLineCap = this.currentLineCap == 2 ? 0 : this.currentLineCap + 1;
        this.emit('show-osd', null, _(LineCapNames[this.currentLineCap]), "", -1);
    },
    
    toggleFillRule: function() {
        this.currentFillRule = this.currentFillRule == 1 ? 0 : this.currentFillRule + 1;
        this.emit('show-osd', null, _(FillRuleNames[this.currentFillRule]), "", -1);
    },
    
    toggleFontWeight: function() {
        let fontWeights = Object.keys(FontWeightNames).map(key => Number(key));
        let index = fontWeights.indexOf(this.currentFontWeight);
        this.currentFontWeight = index == fontWeights.length - 1 ? fontWeights[0] : fontWeights[index + 1];
        if (this.currentElement && this.currentElement.font) {
            this.currentElement.font.weight = this.currentFontWeight;
            this._redisplay();
        }
        this.emit('show-osd', null, `<span font_weight="${this.currentFontWeight}">${_(FontWeightNames[this.currentFontWeight])}</span>`, "", -1);
    },
    
    toggleFontStyle: function() {
        this.currentFontStyle = this.currentFontStyle == 2 ? 0 : this.currentFontStyle + 1;
        if (this.currentElement && this.currentElement.font) {
            this.currentElement.font.style = this.currentFontStyle;
            this._redisplay();
        }
        this.emit('show-osd', null, `<span font_style="${FontStyleNames[this.currentFontStyle].toLowerCase()}">${_(FontStyleNames[this.currentFontStyle])}</span>`, "", -1);
    },
    
    toggleFontFamily: function() {
        this.currentFontGeneric = this.currentFontGeneric == 5 ? 0 : this.currentFontGeneric + 1;
        let currentFontFamily = this.currentFontGeneric == 0 ? this.currentThemeFontFamily : FontGenericNames[this.currentFontGeneric];
        if (this.currentElement && this.currentElement.font) {
            this.currentElement.font.family = currentFontFamily;
            this._redisplay();
        }
        this.emit('show-osd', null, `<span font_family="${currentFontFamily}">${_(currentFontFamily)}</span>`, "", -1);
    },
    
    toggleTextAlignment: function() {
        this.currentTextRightAligned = !this.currentTextRightAligned;
        if (this.currentElement && this.currentElement.textRightAligned !== undefined) {
            this.currentElement.textRightAligned = this.currentTextRightAligned;
            this._redisplay();
        }
        this.emit('show-osd', null, this.currentTextRightAligned ? _("Right aligned") : _("Left aligned"), "", -1);
    },
    
    toggleHelp: function() {
        if (this.helper.visible) {
            this.helper.hideHelp();
            if (this.textEntry)
                this.textEntry.grab_key_focus();
        } else {
            this.helper.showHelp();
            this.grab_key_focus();
        }
        
    },
    
    // The area is reactive when it is modal.
    _onReactiveChanged: function() {
        if (this.hasGrid)
            this._redisplay();
        if (this.helper.visible)
            this.toggleHelp();
        if (this.textEntry && this.reactive)
            this.textEntry.grab_key_focus();
    },
    
    _onDestroy: function() {
        this.disconnect(this.reactiveHandler);
        this.erase();
        if (this._menu)
            this._menu.disable();
    },
    
    updateActionMode: function() {
        this.emit('update-action-mode');
    },
    
    enterDrawingMode: function() {
        this.stageKeyPressedHandler = global.stage.connect('key-press-event', this._onStageKeyPressed.bind(this));
        this.stageKeyReleasedHandler = global.stage.connect('key-release-event', this._onStageKeyReleased.bind(this));
        this.keyPressedHandler = this.connect('key-press-event', this._onKeyPressed.bind(this));
        this.buttonPressedHandler = this.connect('button-press-event', this._onButtonPressed.bind(this));
        this._onKeyboardPopupMenuHandler = this.connect('popup-menu', this._onKeyboardPopupMenu.bind(this));
        this.scrollHandler = this.connect('scroll-event', this._onScroll.bind(this));
        this.get_parent().set_background_color(this.reactive && this.hasBackground ? this.activeBackgroundColor : null);
        this._updateStyle();
    },
    
    leaveDrawingMode: function(save) {
        if (this.stageKeyPressedHandler) {
            global.stage.disconnect(this.stageKeyPressedHandler);
            this.stageKeyPressedHandler = null;
        }
        if (this.stageKeyReleasedHandler) {
            global.stage.disconnect(this.stageKeyReleasedHandler);
            this.stageKeyReleasedHandler = null;
        }
        if (this.keyPressedHandler) {
            this.disconnect(this.keyPressedHandler);
            this.keyPressedHandler = null;
        }
        if (this.buttonPressedHandler) {
            this.disconnect(this.buttonPressedHandler);
            this.buttonPressedHandler = null;
        }
        if (this._onKeyboardPopupMenuHandler) {
            this.disconnect(this._onKeyboardPopupMenuHandler);
            this._onKeyboardPopupMenuHandler = null;
        }
        if (this.elementGrabberHandler) {
            this.disconnect(this.elementGrabberHandler);
            this.elementGrabberHandler = null;
        }
        if (this.motionHandler) {
            this.disconnect(this.motionHandler);
            this.motionHandler = null;
        }
        if (this.buttonReleasedHandler) {
            this.disconnect(this.buttonReleasedHandler);
            this.buttonReleasedHandler = null;
        }
        if (this.scrollHandler) {
            this.disconnect(this.scrollHandler);
            this.scrollHandler = null;
        }
        
        this.currentElement = null;
        this._stopTextCursorTimeout();
        this._redisplay();
        this.closeMenu();
        this.get_parent().set_background_color(null);
        if (save)
            this.savePersistent();
    },
    
    saveAsSvg: function() {
        // stop drawing or writing
        if (this.currentElement && this.currentElement.shape == Shapes.TEXT && this.isWriting) {
            this._stopWriting();
        } else if (this.currentElement && this.currentElement.shape != Shapes.TEXT) {
            this._stopDrawing();
        }
        
        let content = `<svg viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">`;
        if (SVG_DEBUG_EXTENDS)
            content = `<svg viewBox="${-this.width} ${-this.height} ${2 * this.width} ${2 * this.height}" xmlns="http://www.w3.org/2000/svg">`;
        let backgroundColorString = this.hasBackground ? this.activeBackgroundColor.to_string() : 'transparent';
        if (backgroundColorString != 'transparent') {
            content += `\n  <rect id="background" width="100%" height="100%" fill="${backgroundColorString}"/>`;
        }
        if (SVG_DEBUG_EXTENDS) {
            content += `\n  <line stroke="black" x1="0" y1="${-this.height}" x2="0" y2="${this.height}"/>`;
            content += `\n  <line stroke="black" x1="${-this.width}" y1="0" x2="${this.width}" y2="0"/>`;
        }
        for (let i = 0; i < this.elements.length; i++) {
            content += this.elements[i].buildSVG(backgroundColorString);
        }
        content += "\n</svg>";
        
        let filename = `${Me.metadata['svg-file-name']} ${getDateString()}.svg`;
        let dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        let path = GLib.build_filenamev([dir, filename]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return false;
        let success = GLib.file_set_contents(path, content);
        
        if (success) {
            // pass the parent (bgContainer) to Flashspot because coords of this are relative
            let flashspot = new Screenshot.Flashspot(this.get_parent());
            flashspot.fire();
            if (global.play_theme_sound) {
                global.play_theme_sound(0, 'screen-capture', "Save as SVG", null);
            } else if (global.display && global.display.get_sound_player) {
                let player = global.display.get_sound_player();
                player.play_from_theme('screen-capture', "Save as SVG", null);
            }
        }
    },
    
    _saveAsJson: function(name, notify) {
        // stop drawing or writing
        if (this.currentElement && this.currentElement.shape == Shapes.TEXT && this.isWriting) {
            this._stopWriting();
        } else if (this.currentElement && this.currentElement.shape != Shapes.TEXT) {
            this._stopDrawing();
        }
        
        let dir = GLib.build_filenamev([GLib.get_user_data_dir(), Me.metadata['data-dir']]);
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o700);
        let path = GLib.build_filenamev([dir, `${name}.json`]);
        
        let oldContents;
        
        if (name == Me.metadata['persistent-file-name']) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                oldContents = GLib.file_get_contents(path)[1];
                if (oldContents instanceof Uint8Array)
                    oldContents = ByteArray.toString(oldContents);
            }
            
            // do not create a file to write just an empty array
            if (!oldContents && this.elements.length == 0)
                return;
        }
        
        // do not use "content = JSON.stringify(this.elements, null, 2);", neither "content = JSON.stringify(this.elements);"
        // because of compromise between disk usage and human readability
        let contents = `[\n  ` + new Array(...this.elements.map(element => JSON.stringify(element))).join(`,\n\n  `) + `\n]`;
        
        if (name == Me.metadata['persistent-file-name'] && contents == oldContents)
            return;
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            GLib.file_set_contents(path, contents);
            if (notify)
                this.emit('show-osd', 'document-save-symbolic', name, "", -1);
            if (name != Me.metadata['persistent-file-name']) {
                this.jsonName = name;
                this.lastJsonContents = contents;
            }
        });
    },
    
    saveAsJsonWithName: function(name) {
        this._saveAsJson(name);
    },
    
    saveAsJson: function() {
        this._saveAsJson(getDateString(), true);
    },
    
    savePersistent: function() {
        this._saveAsJson(Me.metadata['persistent-file-name']);
    },
    
    syncPersistent: function() {
        // do not override peristent.json with an empty drawing when changing persistency setting
        if (!this.elements.length)
            this._loadPersistent();
        else
            this.savePersistent();
            
    },
    
    _loadJson: function(name, notify) {
        // stop drawing or writing
        if (this.currentElement && this.currentElement.shape == Shapes.TEXT && this.isWriting) {
            this._stopWriting();
        } else if (this.currentElement && this.currentElement.shape != Shapes.TEXT) {
            this._stopDrawing();
        }
        this.elements = [];
        this.currentElement = null;
        
        let dir = GLib.get_user_data_dir();
        let path = GLib.build_filenamev([dir, Me.metadata['data-dir'], `${name}.json`]);
        
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        let [success, contents] = GLib.file_get_contents(path);
        if (!success)
            return;
        if (contents instanceof Uint8Array)
            contents = ByteArray.toString(contents);
        this.elements.push(...JSON.parse(contents).map(object => new DrawingElement(object)));
        
        if (notify)
            this.emit('show-osd', 'document-open-symbolic', name, "", -1);
        if (name != Me.metadata['persistent-file-name']) {
            this.jsonName = name;
            this.lastJsonContents = contents;
        }
    },
    
    _loadPersistent: function() {
        this._loadJson(Me.metadata['persistent-file-name']);
    },
    
    loadJson: function(name, notify) {
        this._loadJson(name, notify);
        this._redisplay();
    },
    
    loadNextJson: function() {
        let names = getJsonFiles().map(file => file.name);
        
        if (!names.length)
            return;
        
        let nextName = names[this.jsonName && names.indexOf(this.jsonName) != names.length - 1 ? names.indexOf(this.jsonName) + 1 : 0];
        this.loadJson(nextName, true);
    },
    
    loadPreviousJson: function() {
        let names = getJsonFiles().map(file => file.name);
        
        if (!names.length)
            return;
        
        let previousName = names[this.jsonName && names.indexOf(this.jsonName) > 0 ? names.indexOf(this.jsonName) - 1 : names.length - 1];
        this.loadJson(previousName, true);
    },
    
    get drawingContentsHasChanged() {
        let contents = `[\n  ` + new Array(...this.elements.map(element => JSON.stringify(element))).join(`,\n\n  `) + `\n]`;
        return contents != this.lastJsonContents;
    }
});

const RADIAN = 180 / Math.PI;               // degree
const INVERSION_CIRCLE_RADIUS = 12;         // px
const REFLECTION_TOLERANCE = 5;             // px,  to select vertical and horizontal directions
const STRETCH_TOLERANCE = Math.PI / 8;      // rad, to select vertical and horizontal directions
const MIN_REFLECTION_LINE_LENGTH = 10;      // px
const MIN_TRANSLATION_DISTANCE = 1;         // px
const MIN_ROTATION_ANGLE = Math.PI / 1000;  // rad
const MIN_DRAWING_SIZE = 3;                 // px

// DrawingElement represents a "brushstroke".
// It can be converted into a cairo path as well as a svg element.
// See DrawingArea._startDrawing() to know its params.
const DrawingElement = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingElement',
    
    _init: function(params) {
        for (let key in params)
            this[key] = params[key];
        
        // compatibility with json generated by old extension versions
        
        if (params.fillRule === undefined)
            this.fillRule = Cairo.FillRule.WINDING;
        if (params.transformations === undefined)
            this.transformations = [];
        if (params.shape == Shapes.TEXT) {
            if (params.font && params.font.weight === 0)
                this.font.weight = 400;
            if (params.font && params.font.weight === 1)
                this.font.weight = 700;
        }
        
        if (params.transform && params.transform.center) {
            let angle = (params.transform.angle || 0) + (params.transform.startAngle || 0);
            if (angle)
                this.transformations.push({ type: Transformations.ROTATION, angle: angle });
        }
        if (params.shape == Shapes.ELLIPSE && params.transform && params.transform.ratio && params.transform.ratio != 1 && params.points.length >= 2) {
            let [ratio, p0, p1] = [params.transform.ratio, params.points[0], params.points[1]];
            // Add a fake point that will give the right ellipse ratio when building the element.
            this.points.push([ratio * (p1[0] - p0[0]) + p0[0], ratio * (p1[1] - p0[1]) + p0[1]]);
        }
        delete this.transform;
    },
    
    // toJSON is called by JSON.stringify
    toJSON: function() {
        return {
            shape: this.shape,
            color: this.color,
            line: this.line,
            dash: this.dash,
            fill: this.fill,
            fillRule: this.fillRule,
            eraser: this.eraser,
            transformations: this.transformations,
            text: this.text,
            lineIndex: this.lineIndex !== undefined ? this.lineIndex : undefined,
            textRightAligned: this.textRightAligned,
            font: this.font,
            points: this.points.map((point) => [Math.round(point[0]*100)/100, Math.round(point[1]*100)/100])
        };
    },
    
    buildCairo: function(cr, params) {
        let [success, color] = Clutter.Color.from_string(this.color);
        if (success)
            Clutter.cairo_set_source_color(cr, color);
        
        if (this.showSymmetryElement) {
            let transformation = this.lastTransformation;
            setDummyStroke(cr);
            if (transformation.type == Transformations.REFLECTION) {
                cr.moveTo(transformation.startX, transformation.startY);
                cr.lineTo(transformation.endX, transformation.endY);
            } else {
                cr.arc(transformation.endX, transformation.endY, INVERSION_CIRCLE_RADIUS, 0, 2 * Math.PI);
            }
            cr.stroke();
        }
        
        cr.setLineCap(this.line.lineCap);
        cr.setLineJoin(this.line.lineJoin);
        cr.setLineWidth(this.line.lineWidth);
        if (this.fillRule)
            cr.setFillRule(this.fillRule);
        
        if (this.dash && this.dash.active && this.dash.array && this.dash.array[0] && this.dash.array[1])
            cr.setDash(this.dash.array, this.dash.offset);
        
        if (this.eraser)
            cr.setOperator(Cairo.Operator.CLEAR);
        else
            cr.setOperator(Cairo.Operator.OVER);
        
        if (params.dummyStroke)
            setDummyStroke(cr);
        
        if (SVG_DEBUG_SUPERPOSES_CAIRO) {
            Clutter.cairo_set_source_color(cr, Clutter.Color.new(255, 0, 0, 255));
            cr.setLineWidth(this.line.lineWidth / 2 || 1);
        }
        
        this.transformations.slice(0).reverse().forEach(transformation => {
            if (transformation.type == Transformations.TRANSLATION) {
                cr.translate(transformation.slideX, transformation.slideY);
            } else if (transformation.type == Transformations.ROTATION) {
                let center = this._getTransformedCenter(transformation);
                cr.translate(center[0], center[1]);
                cr.rotate(transformation.angle);
                cr.translate(-center[0], -center[1]);
            } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                let center = this._getTransformedCenter(transformation);
                cr.translate(center[0], center[1]);
                cr.rotate(transformation.angle);
                cr.scale(transformation.scaleX, transformation.scaleY);
                cr.rotate(-transformation.angle);
                cr.translate(-center[0], -center[1]);
            } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                cr.translate(transformation.slideX, transformation.slideY);
                cr.rotate(transformation.angle);
                cr.scale(transformation.scaleX, transformation.scaleY);
                cr.rotate(-transformation.angle);
                cr.translate(-transformation.slideX, -transformation.slideY);
            }
        });
        
        let [points, shape] = [this.points, this.shape];
        
        if (shape == Shapes.LINE && points.length == 3) {
            cr.moveTo(points[0][0], points[0][1]);
            cr.curveTo(points[0][0], points[0][1], points[1][0], points[1][1], points[2][0], points[2][1]);
            
        } else if (shape == Shapes.LINE && points.length == 4) {
            cr.moveTo(points[0][0], points[0][1]);
            cr.curveTo(points[1][0], points[1][1], points[2][0], points[2][1], points[3][0], points[3][1]);
            
        } else if (shape == Shapes.NONE || shape == Shapes.LINE) {
            cr.moveTo(points[0][0], points[0][1]);
            for (let j = 1; j < points.length; j++) {
                cr.lineTo(points[j][0], points[j][1]);
            }
            
        } else if (shape == Shapes.ELLIPSE && points.length >= 2) {
            let radius = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            let ratio = 1;
            
            if (points[2]) {
                ratio = Math.hypot(points[2][0] - points[0][0], points[2][1] - points[0][1]) / radius;
                cr.translate(points[0][0], points[0][1]);
                cr.scale(ratio, 1);
                cr.translate(-points[0][0], -points[0][1]);
                cr.arc(points[0][0], points[0][1], radius, 0, 2 * Math.PI);
                cr.translate(points[0][0], points[0][1]);
                cr.scale(1 / ratio, 1);
                cr.translate(-points[0][0], -points[0][1]);
            } else
                cr.arc(points[0][0], points[0][1], radius, 0, 2 * Math.PI);
            
        } else if (shape == Shapes.RECTANGLE && points.length == 2) {
            cr.rectangle(points[0][0], points[0][1], points[1][0] - points[0][0], points[1][1] - points[0][1]);
        
        } else if ((shape == Shapes.POLYGON || shape == Shapes.POLYLINE) && points.length >= 2) {
            cr.moveTo(points[0][0], points[0][1]);
            for (let j = 1; j < points.length; j++) {
                cr.lineTo(points[j][0], points[j][1]);
            }
            if (shape == Shapes.POLYGON)
                cr.closePath();
            
        } else if (shape == Shapes.TEXT && points.length == 2) {
            let layout = PangoCairo.create_layout(cr);
            let fontSize = Math.abs(points[1][1] - points[0][1]) * Pango.SCALE;
            let fontDescription = new Pango.FontDescription();
            fontDescription.set_absolute_size(fontSize);
            ['family', 'weight', 'style', 'stretch', 'variant'].forEach(attribute => {
                if (this.font[attribute] !== undefined)
                    try {
                        fontDescription[`set_${attribute}`](this.font[attribute]);
                    } catch(e) {}
            });
            layout.set_font_description(fontDescription);
            layout.set_text(this.text, -1);
            this.textWidth = layout.get_pixel_size()[0];
            cr.moveTo(points[1][0] - (this.textRightAligned ? this.textWidth : 0), Math.max(points[0][1],points[1][1]) - layout.get_baseline() / Pango.SCALE);
            layout.set_text(this.text, -1);
            PangoCairo.show_layout(cr, layout);
            
            if (params.showTextCursor) {
                let cursorPosition = this.cursorPosition == -1 ? this.text.length : this.cursorPosition;
                layout.set_text(this.text.slice(0, cursorPosition), -1);
                let width = layout.get_pixel_size()[0];
                cr.rectangle(points[1][0] - (this.textRightAligned ? this.textWidth : 0) + width, Math.max(points[0][1],points[1][1]),
                             Math.abs(points[1][1] - points[0][1]) / 25, - Math.abs(points[1][1] - points[0][1]));
                cr.fill();
            }
            
            if (params.showTextRectangle || params.drawTextRectangle) {
                cr.rectangle(points[1][0] - (this.textRightAligned ? this.textWidth : 0), Math.max(points[0][1], points[1][1]),
                             this.textWidth, - Math.abs(points[1][1] - points[0][1]));
                if (params.showTextRectangle)
                    setDummyStroke(cr);
                else
                    // Only draw the rectangle to find the element, not to show it.
                    cr.setLineWidth(0);
            }
        }
        
        cr.identityMatrix();
    },
    
    getContainsPoint: function(cr, x, y) {
        if (this.shape == Shapes.TEXT)
            return cr.inFill(x, y);
        
        cr.save();
        cr.setLineWidth(Math.max(this.line.lineWidth, 25));
        cr.setDash([], 0);
        
        // Check whether the point is inside/on/near the element.
        let inElement = cr.inStroke(x, y) || this.fill && cr.inFill(x, y);
        cr.restore();
        return inElement;
    },
    
    buildSVG: function(bgColor) {
        let row = "\n  ";
        let points = this.points.map((point) => [Math.round(point[0]*100)/100, Math.round(point[1]*100)/100]);
        let color = this.eraser ? bgColor : this.color;
        let fill = this.fill && !this.isStraightLine;
        let attributes = '';
        
        if (fill) {
            attributes = `fill="${color}"`;
            if (this.fillRule)
                attributes += ` fill-rule="${FillRuleNames[this.fillRule].toLowerCase()}"`;
        } else {
            attributes = `fill="none"`;
        }
        
        if (this.line && this.line.lineWidth) {
            attributes += ` stroke="${color}"` +
                          ` stroke-width="${this.line.lineWidth}"`;
            if (this.line.lineCap)
                attributes += ` stroke-linecap="${LineCapNames[this.line.lineCap].toLowerCase()}"`;
            if (this.line.lineJoin && !this.isStraightLine)
                attributes += ` stroke-linejoin="${LineJoinNames[this.line.lineJoin].toLowerCase()}"`;
            if (this.dash && this.dash.active && this.dash.array && this.dash.array[0] && this.dash.array[1])
                attributes += ` stroke-dasharray="${this.dash.array[0]} ${this.dash.array[1]}" stroke-dashoffset="${this.dash.offset}"`;
        } else {
            attributes += ` stroke="none"`;
        }
        
        let transAttribute = '';
        this.transformations.slice(0).reverse().forEach(transformation => {
            transAttribute += transAttribute ? ' ' : ' transform="';
            let center = this._getTransformedCenter(transformation);
            
            if (transformation.type == Transformations.TRANSLATION) {
                transAttribute += `translate(${transformation.slideX},${transformation.slideY})`;
            } else if (transformation.type == Transformations.ROTATION) {
                transAttribute += `translate(${center[0]},${center[1]}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-center[0]},${-center[1]})`;
            } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                transAttribute += `translate(${center[0]},${center[1]}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `scale(${transformation.scaleX},${transformation.scaleY}) `;
                transAttribute += `rotate(${-transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-center[0]},${-center[1]})`;
            } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                transAttribute += `translate(${transformation.slideX}, ${transformation.slideY}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `scale(${transformation.scaleX}, ${transformation.scaleY}) `;
                transAttribute += `rotate(${-transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-transformation.slideX}, ${-transformation.slideY})`;
            }
        });
        transAttribute += transAttribute ? '"' : '';
        
        if (this.shape == Shapes.LINE && points.length == 4) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            row += ` C ${points[1][0]} ${points[1][1]}, ${points[2][0]} ${points[2][1]}, ${points[3][0]} ${points[3][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.LINE && points.length == 3) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            row += ` C ${points[0][0]} ${points[0][1]}, ${points[1][0]} ${points[1][1]}, ${points[2][0]} ${points[2][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.LINE) {
            row += `<line ${attributes} x1="${points[0][0]}" y1="${points[0][1]}" x2="${points[1][0]}" y2="${points[1][1]}"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.NONE) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            for (let i = 1; i < points.length; i++)
                row += ` L ${points[i][0]} ${points[i][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.ELLIPSE && points.length == 3) {
            let ry = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            let rx = Math.hypot(points[2][0] - points[0][0], points[2][1] - points[0][1]);
            row += `<ellipse ${attributes} cx="${points[0][0]}" cy="${points[0][1]}" rx="${rx}" ry="${ry}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.ELLIPSE && points.length == 2) {
            let r = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            row += `<circle ${attributes} cx="${points[0][0]}" cy="${points[0][1]}" r="${r}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.RECTANGLE && points.length == 2) {
            row += `<rect ${attributes} x="${Math.min(points[0][0], points[1][0])}" y="${Math.min(points[0][1], points[1][1])}" ` +
                   `width="${Math.abs(points[1][0] - points[0][0])}" height="${Math.abs(points[1][1] - points[0][1])}"${transAttribute}/>`;
                   
        } else if (this.shape == Shapes.POLYGON && points.length >= 3) {
            row += `<polygon ${attributes} points="`;
            for (let i = 0; i < points.length; i++)
                row += ` ${points[i][0]},${points[i][1]}`;
            row += `"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.POLYLINE && points.length >= 2) {
            row += `<polyline ${attributes} points="`;
            for (let i = 0; i < points.length; i++)
                row += ` ${points[i][0]},${points[i][1]}`;
            row += `"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.TEXT && points.length == 2) {
            attributes = `fill="${color}" ` +
                         `stroke="transparent" ` +
                         `stroke-opacity="0" ` +
                         `font-size="${Math.abs(points[1][1] - points[0][1])}"`;
            
            if (this.font.family)
                attributes += ` font-family="${this.font.family}"`;
            if (this.font.weight && this.font.weight != Pango.Weight.NORMAL)
                attributes += ` font-weight="${this.font.weight}"`;
            if (this.font.style && FontStyleNames[this.font.style])
                attributes += ` font-style="${FontStyleNames[this.font.style].toLowerCase()}"`;
            if (FontStretchNames[this.font.stretch] && this.font.stretch != Pango.Stretch.NORMAL)
                attributes += ` font-stretch="${FontStretchNames[this.font.stretch].toLowerCase()}"`;
            if (this.font.variant && FontVariantNames[this.font.variant])
                attributes += ` font-variant="${FontVariantNames[this.font.variant].toLowerCase()}"`;
            
            // this.textWidth is computed during Cairo building.
            row += `<text ${attributes} x="${points[1][0] - (this.textRightAligned ? this.textWidth : 0)}" `;
            row += `y="${Math.max(points[0][1], points[1][1])}"${transAttribute}>${this.text}</text>`;
        }
        
        return row;
    },
    
    get lastTransformation() {
        if (!this.transformations.length)
            return null;
        
        return this.transformations[this.transformations.length - 1];
    },
    
    get isStraightLine() {
        return this.shape == Shapes.LINE && this.points.length == 2;
    },
    
    smoothAll: function() {
        for (let i = 0; i < this.points.length; i++) {
            this._smooth(i);
        }
    },
    
    addPoint: function() {
        if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) {
            // copy last point
            let [lastPoint, secondToLastPoint] = [this.points[this.points.length - 1], this.points[this.points.length - 2]];
            if (!getNearness(secondToLastPoint, lastPoint, MIN_DRAWING_SIZE))
                this.points.push([lastPoint[0], lastPoint[1]]);
        } else if (this.shape == Shapes.LINE) {
            if (this.points.length == 2) {
                this.points[2] = this.points[1];
            } else if (this.points.length == 3) {
                this.points[3] = this.points[2];
                this.points[2] = this.points[1];
            }
        }
    },
    
    startDrawing: function(startX, startY) {
        this.points.push([startX, startY]);
        
        if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE)
            this.points.push([startX, startY]);
    },
    
    updateDrawing: function(x, y, transform) {
        let points = this.points;
        if (x == points[points.length - 1][0] && y == points[points.length - 1][1])
            return;
        
        transform = transform || this.transformations.length >= 1;
        
        if (this.shape == Shapes.NONE) {
            points.push([x, y]);
            if (transform)
                this._smooth(points.length - 1);
            
        } else if ((this.shape == Shapes.RECTANGLE || this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) && transform) {
            if (points.length < 2)
                return;
                
            let center = this._getOriginalCenter();
            this.transformations[0] = { type: Transformations.ROTATION,
                                        angle: getAngle(center[0], center[1], points[points.length - 1][0], points[points.length - 1][1], x, y) };
            
        } else if (this.shape == Shapes.ELLIPSE && transform) {
            if (points.length < 2)
                return;
            
            points[2] = [x, y];
            let center = this._getOriginalCenter();
            this.transformations[0] = { type: Transformations.ROTATION,
                                        angle: getAngle(center[0], center[1], center[0] + 1, center[1], x, y) };
            
        } else if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) {
            points[points.length - 1] = [x, y];
            
        } else if (this.shape == Shapes.TEXT && transform) {
           if (points.length < 2)
                return;
        
            let [slideX, slideY] = [x - points[1][0], y - points[1][1]];
            points[0] = [points[0][0] + slideX, points[0][1] + slideY];
            points[1] = [x, y];
        
        } else {
            points[1] = [x, y];
            
        }
    },
    
    stopDrawing: function() {
        // skip when the size is too small to be visible (3px) (except for free drawing)
        if (this.shape != Shapes.NONE && this.points.length >= 2) {
            let lastPoint = this.points[this.points.length - 1];
            let secondToLastPoint = this.points[this.points.length - 2];
            if (getNearness(secondToLastPoint, lastPoint, MIN_DRAWING_SIZE))
                this.points.pop();
        }
        
        if (this.transformations[0] && this.transformations[0].type == Transformations.ROTATION &&
                Math.abs(this.transformations[0].angle) < MIN_ROTATION_ANGLE)
            this.transformations.shift();
    },
    
    startTransformation: function(startX, startY, type) {
        if (type == Transformations.TRANSLATION)
            this.transformations.push({ startX: startX, startY: startY, type: type, slideX: 0, slideY: 0 });
        else if (type == Transformations.ROTATION)
            this.transformations.push({ startX: startX, startY: startY, type: type, angle: 0 });
        else if (type == Transformations.SCALE_PRESERVE || type == Transformations.STRETCH)
            this.transformations.push({ startX: startX, startY: startY, type: type, scaleX: 1, scaleY: 1, angle: 0 });
        else if (type == Transformations.REFLECTION)
            this.transformations.push({ startX: startX, startY: startY, endX: startX, endY: startY, type: type,
                                        scaleX:  1, scaleY:  1, slideX: 0, slideY: 0, angle: 0 });
        else if (type == Transformations.INVERSION)
            this.transformations.push({ startX: startX, startY: startY, endX: startX, endY: startY, type: type,
                                        scaleX: -1, scaleY: -1, slideX: startX, slideY: startY,
                                        angle: Math.PI + Math.atan(startY / (startX || 1)) });
        
        if (type == Transformations.REFLECTION || type == Transformations.INVERSION)
            this.showSymmetryElement = true;
    },
    
    updateTransformation: function(x, y) {
        let transformation = this.lastTransformation;
        
        if (transformation.type == Transformations.TRANSLATION) {
            transformation.slideX = x - transformation.startX;
            transformation.slideY = y - transformation.startY;
        } else if (transformation.type == Transformations.ROTATION) {
            let center = this._getTransformedCenter(transformation);
            transformation.angle = getAngle(center[0], center[1], transformation.startX, transformation.startY, x, y);
        } else if (transformation.type == Transformations.SCALE_PRESERVE) {
            let center = this._getTransformedCenter(transformation);
            let scale = Math.hypot(x - center[0], y - center[1]) / Math.hypot(transformation.startX - center[0], transformation.startY - center[1]) || 1;
            [transformation.scaleX, transformation.scaleY] = [scale, scale];
        } else if (transformation.type == Transformations.STRETCH) {
            let center = this._getTransformedCenter(transformation);
            let startAngle = getAngle(center[0], center[1], center[0] + 1, center[1], transformation.startX, transformation.startY);
            let vertical = Math.abs(Math.sin(startAngle)) >= Math.sin(Math.PI / 2 - STRETCH_TOLERANCE);
            let horizontal = Math.abs(Math.cos(startAngle)) >= Math.cos(STRETCH_TOLERANCE);
            let scale = Math.hypot(x - center[0], y - center[1]) / Math.hypot(transformation.startX - center[0], transformation.startY - center[1]) || 1;
            transformation.scaleX = vertical ? 1 : scale;
            transformation.scaleY = !vertical ? 1 : scale;
            transformation.angle = vertical || horizontal ? 0 : getAngle(center[0], center[1], center[0] + 1, center[1], x, y);
        } else if (transformation.type == Transformations.REFLECTION) {
            [transformation.endX, transformation.endY] = [x, y];
            if (getNearness([transformation.startX, transformation.startY], [x, y], MIN_REFLECTION_LINE_LENGTH)) {
                // do nothing to avoid jumps (no transformation at starting and locked transformation after)
            } else if (Math.abs(y - transformation.startY) <= REFLECTION_TOLERANCE && Math.abs(x - transformation.startX) > REFLECTION_TOLERANCE) {
                [transformation.scaleX, transformation.scaleY] = [1, -1];
                [transformation.slideX, transformation.slideY] = [0, transformation.startY];
                transformation.angle = Math.PI;
            } else if (Math.abs(x - transformation.startX) <= REFLECTION_TOLERANCE && Math.abs(y - transformation.startY) > REFLECTION_TOLERANCE) {
                [transformation.scaleX, transformation.scaleY] = [-1, 1];
                [transformation.slideX, transformation.slideY] = [transformation.startX, 0];
                transformation.angle = Math.PI;
            } else if (x != transformation.startX) {
                let tan = (y - transformation.startY) / (x - transformation.startX);
                [transformation.scaleX, transformation.scaleY] = [1, -1];
                [transformation.slideX, transformation.slideY] = [0, transformation.startY - transformation.startX * tan];
                transformation.angle = Math.PI + Math.atan(tan);
            } else if (y != transformation.startY) {
                let tan = (x - transformation.startX) / (y - transformation.startY);
                [transformation.scaleX, transformation.scaleY] = [-1, 1];
                [transformation.slideX, transformation.slideY] = [transformation.startX - transformation.startY * tan, 0];
                transformation.angle = Math.PI - Math.atan(tan);
            }
        } else if (transformation.type == Transformations.INVERSION) {
            [transformation.endX, transformation.endY] = [x, y];
            [transformation.scaleX, transformation.scaleY] = [-1, -1];
            [transformation.slideX, transformation.slideY] = [x, y];
            transformation.angle = Math.PI + Math.atan(y / (x || 1));
        }
    },
    
    stopTransformation: function() {
        // Clean transformations
        let transformation = this.lastTransformation;
        
        if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION)
            this.showSymmetryElement = false;
        
        if (transformation.type == Transformations.REFLECTION &&
                getNearness([transformation.startX, transformation.startY], [transformation.endX, transformation.endY], MIN_REFLECTION_LINE_LENGTH) ||
            transformation.type == Transformations.TRANSLATION && Math.hypot(transformation.slideX, transformation.slideY) < MIN_TRANSLATION_DISTANCE ||
            transformation.type == Transformations.ROTATION && Math.abs(transformation.angle) < MIN_ROTATION_ANGLE) {
            
            this.transformations.pop();
        } else {
            delete transformation.startX;
            delete transformation.startY;
            delete transformation.endX;
            delete transformation.endY;
        }
    },
    
    // When rotating grouped lines, lineOffset is used to retrieve the rotation center of the first line.
    _getLineOffset: function() {
        return (this.lineIndex || 0) * Math.abs(this.points[1][1] - this.points[0][1]);
    },
    
    // The figure rotation center before transformations (original).
    // this.textWidth is computed during Cairo building.
    _getOriginalCenter: function() {
        if (!this._originalCenter) {
            let points = this.points;
            this._originalCenter = this.shape == Shapes.ELLIPSE ? [points[0][0], points[0][1]] :
                                   this.shape == Shapes.LINE && points.length == 4 ? getCurveCenter(points[0], points[1], points[2], points[3]) :
                                   this.shape == Shapes.LINE && points.length == 3 ? getCurveCenter(points[0], points[0], points[1], points[2]) :
                                   this.shape == Shapes.TEXT && this.textWidth ? [points[1][0], Math.max(points[0][1], points[1][1]) - this._getLineOffset()] :
                                   points.length >= 3 ? getCentroid(points) :
                                   getNaiveCenter(points);
        }
        
        return this._originalCenter;
    },
    
    // The figure rotation center, whose position is affected by all transformations done before 'transformation'.
    _getTransformedCenter: function(transformation) {
        if (!transformation.elementTransformedCenter) {
            let matrix = new Pango.Matrix({ xx: 1, xy: 0, yx: 0, yy: 1, x0: 0, y0: 0 });
            
            // Apply transformations to the matrice in reverse order
            // because Pango multiply matrices by the left when applying a transformation
            this.transformations.slice(0, this.transformations.indexOf(transformation)).reverse().forEach(transformation => {
                if (transformation.type == Transformations.TRANSLATION) {
                    matrix.translate(transformation.slideX, transformation.slideY);
                } else if (transformation.type == Transformations.ROTATION) {
                    // nothing, the center position is preserved.
                } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                    // nothing, the center position is preserved.
                } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                    matrix.translate(transformation.slideX, transformation.slideY);
                    matrix.rotate(-transformation.angle * RADIAN);
                    matrix.scale(transformation.scaleX, transformation.scaleY);
                    matrix.rotate(transformation.angle * RADIAN);
                    matrix.translate(-transformation.slideX, -transformation.slideY);
                }
            });
            
            let originalCenter = this._getOriginalCenter();
            transformation.elementTransformedCenter = matrix.transform_point(originalCenter[0], originalCenter[1]);
        }
        
        return transformation.elementTransformedCenter;
    },
    
    _smooth: function(i) {
        if (i < 2)
            return;
        this.points[i-1] = [(this.points[i-2][0] + this.points[i][0]) / 2, (this.points[i-2][1] + this.points[i][1]) / 2];
    }
});

const setDummyStroke = function(cr) {
    cr.setLineWidth(2);
    cr.setLineCap(0);
    cr.setLineJoin(0);
    cr.setDash([1, 2], 0);
};

/*
    Some geometric utils
*/

const getNearness = function(pointA, pointB, distance) {
    return Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]) < distance;
};

// mean of the vertices, ok for regular polygons
const getNaiveCenter = function(points) {
    return points.reduce((accumulator, point) => accumulator = [accumulator[0] + point[0], accumulator[1] + point[1]])
                 .map(coord => coord / points.length);
};

// https://en.wikipedia.org/wiki/Centroid#Of_a_polygon
const getCentroid = function(points) {
    let n = points.length;
    points.push(points[0]);
    
    let [sA, sX, sY] = [0, 0, 0];
    for (let i = 0; i <= n-1; i++) {
        let a = points[i][0]*points[i+1][1] - points[i+1][0]*points[i][1];
        sA += a;
        sX += (points[i][0] + points[i+1][0]) * a;
        sY += (points[i][1] + points[i+1][1]) * a;
    }
    
    points.pop();
    if (sA == 0)
        return getNaiveCenter(points);
    return [sX / (3 * sA), sY / (3 * sA)];
};

/*
Cubic Bézier:
[0, 1] -> ℝ², P(t) = (1-t)³P₀ + 3t(1-t)²P₁ + 3t²(1-t)P₂ + t³P₃

general case:

const cubicBezierCoord = function(x0, x1, x2, x3, t) {
    return (1-t)**3*x0 + 3*t*(1-t)**2*x1 + 3*t**2*(1-t)*x2 + t**3*x3;
}

const cubicBezierPoint = function(p0, p1, p2, p3, t) {
    return [cubicBezier(p0[0], p1[0], p2[0], p3[0], t), cubicBezier(p0[1], p1[1], p2[1], p3[1], t)];
}

Approximatively: 
control point: p0 ----  p1  ----  p2  ----  p3  (p2 is not on the curve)
            t: 0  ---- 1/3  ---- 2/3  ----  1
*/

// If the curve has a symmetry axis, it is truly a center (the intersection of the curve and the axis).
// In other cases, it is not a notable point, just a visual approximation.
const getCurveCenter = function(p0, p1, p2, p3) {
    if (p0[0] == p1[0] && p0[1] == p1[1])
        // p0 = p1, t = 2/3
        return [(p1[0] + 6*p1[0] + 12*p2[0] + 8*p3[0]) / 27, (p1[1] + 6*p1[1] + 12*p2[1] + 8*p3[1]) / 27];
    else
        // t = 1/2
        return [(p0[0] + 3*p1[0] + 3*p2[0] + p3[0]) / 8, (p0[1] + 3*p1[1] + 3*p2[1] + p3[1]) / 8];
};

const getAngle = function(xO, yO, xA, yA, xB, yB) {
    // calculate angle of rotation in absolute value
    // cos(AOB) = (OA.OB)/(||OA||*||OB||) where OA.OB = (xA-xO)*(xB-xO) + (yA-yO)*(yB-yO)
    let cos = ((xA - xO)*(xB - xO) + (yA - yO)*(yB - yO)) / (Math.hypot(xA - xO, yA - yO) * Math.hypot(xB - xO, yB - yO));
    
    // acos is defined on [-1, 1] but
    // with A == B and imperfect computer calculations, cos may be equal to 1.00000001.
    cos = Math.min(Math.max(-1, cos), 1);
    let angle = Math.acos( cos );
    
    // determine the sign of the angle
    if (xA == xO) {
        if (xB > xO)
            angle = -angle;
    } else {
        // equation of OA: y = ax + b
        let a = (yA - yO) / (xA - xO);
        let b = yA - a*xA;
        if (yB < a*xB + b)
            angle = - angle;
        if (xA < xO)
            angle = - angle;
    }
    
    return angle;
};

const HELPER_ANIMATION_TIME = 0.25;
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const MEDIA_KEYS_KEYS = {
    'screenshot': "Screenshot",
    'screenshot-clip': "Screenshot to clipboard",
    'area-screenshot': "Area screenshot",
    'area-screenshot-clip': "Area screenshot to clipboard"
};

// DrawingHelper provides the "help osd" (Ctrl + F1)
// It uses the same texts as in prefs
var DrawingHelper = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingHelper',
    Extends: St.ScrollView,
    
    _init: function(params, monitor) {
        params.style_class = 'osd-window draw-on-your-screen-helper';
        this.parent(params);
        this.monitor = monitor;
        this.hide();
        this.settings = Convenience.getSettings();
        
        this.settingHandler = this.settings.connect('changed', this._onSettingChanged.bind(this));
        this.connect('destroy', () => this.settings.disconnect(this.settingHandler));
    },
    
    _onSettingChanged: function(settings, key) {
        if (key == 'toggle-help')
            this._updateHelpKeyLabel();
        
        if (this.vbox) {
            this.vbox.destroy();
            this.vbox = null;
        }
    },
    
    _updateHelpKeyLabel: function() {
        let [keyval, mods] = Gtk.accelerator_parse(this.settings.get_strv('toggle-help')[0]);
        this._helpKeyLabel = Gtk.accelerator_get_label(keyval, mods);
    },
    
    get helpKeyLabel() {
        if (!this._helpKeyLabel)
            this._updateHelpKeyLabel();
        
        return this._helpKeyLabel;
    },
    
    _populate: function() {
        this.vbox = new St.BoxLayout({ vertical: true });
        this.add_actor(this.vbox);
        this.vbox.add_child(new St.Label({ text: _("Global") }));
        
        for (let settingKey in Prefs.GLOBAL_KEYBINDINGS) {
            let hbox = new St.BoxLayout({ vertical: false });
            if (settingKey.indexOf('-separator-') != -1) {
                this.vbox.add_child(hbox);
                continue;
            }
            if (!this.settings.get_strv(settingKey)[0])
                continue;
            let [keyval, mods] = Gtk.accelerator_parse(this.settings.get_strv(settingKey)[0]);
            hbox.add_child(new St.Label({ text: _(Prefs.GLOBAL_KEYBINDINGS[settingKey]) }));
            hbox.add_child(new St.Label({ text: Gtk.accelerator_get_label(keyval, mods), x_expand: true }));
            this.vbox.add_child(hbox);
        }
        
        this.vbox.add_child(new St.Label({ text: _("Internal") }));
        
        for (let i = 0; i < Prefs.OTHER_SHORTCUTS.length; i++) {
            if (Prefs.OTHER_SHORTCUTS[i].desc.indexOf('-separator-') != -1) {
                this.vbox.add_child(new St.BoxLayout({ vertical: false, style_class: 'draw-on-your-screen-helper-separator' }));
                continue;
            }
            let hbox = new St.BoxLayout({ vertical: false });
            hbox.add_child(new St.Label({ text: _(Prefs.OTHER_SHORTCUTS[i].desc) }));
            hbox.add_child(new St.Label({ text: Prefs.OTHER_SHORTCUTS[i].shortcut, x_expand: true }));
            hbox.get_children()[0].get_clutter_text().set_use_markup(true);
            this.vbox.add_child(hbox);
        }
        
        this.vbox.add_child(new St.BoxLayout({ vertical: false, style_class: 'draw-on-your-screen-helper-separator' }));
        
        for (let settingKey in Prefs.INTERNAL_KEYBINDINGS) {
            if (settingKey.indexOf('-separator-') != -1) {
                this.vbox.add_child(new St.BoxLayout({ vertical: false, style_class: 'draw-on-your-screen-helper-separator' }));
                continue;
            }
            let hbox = new St.BoxLayout({ vertical: false });
            if (!this.settings.get_strv(settingKey)[0])
                continue;
            let [keyval, mods] = Gtk.accelerator_parse(this.settings.get_strv(settingKey)[0]);
            hbox.add_child(new St.Label({ text: _(Prefs.INTERNAL_KEYBINDINGS[settingKey]) }));
            hbox.add_child(new St.Label({ text: Gtk.accelerator_get_label(keyval, mods), x_expand: true }));
            this.vbox.add_child(hbox);
        }
        
        let mediaKeysSettings;
        try { mediaKeysSettings = Convenience.getSettings(MEDIA_KEYS_SCHEMA); } catch(e) { return; }
        this.vbox.add_child(new St.Label({ text: _("System") }));
        
        for (let settingKey in MEDIA_KEYS_KEYS) {
            if (!mediaKeysSettings.settings_schema.has_key(settingKey))
                continue;
            let shortcut = GS_VERSION < '3.33.0' ? mediaKeysSettings.get_string(settingKey) : mediaKeysSettings.get_strv(settingKey)[0];
            if (!shortcut)
                continue;
            let [keyval, mods] = Gtk.accelerator_parse(shortcut);
            let hbox = new St.BoxLayout({ vertical: false });
            hbox.add_child(new St.Label({ text: _(MEDIA_KEYS_KEYS[settingKey]) }));
            hbox.add_child(new St.Label({ text: Gtk.accelerator_get_label(keyval, mods), x_expand: true }));
            this.vbox.add_child(hbox);
        }
    },
    
    showHelp: function() {
        if (!this.vbox)
            this._populate();
        
        this.opacity = 0;
        this.show();
        
        let maxHeight = this.monitor.height * 3 / 4;
        this.set_height(Math.min(this.height, maxHeight));
        this.set_position(Math.floor(this.monitor.width / 2 - this.width / 2),
                          Math.floor(this.monitor.height / 2 - this.height / 2));
                          
        if (this.height == maxHeight)
            this.vscrollbar_policy = Gtk.PolicyType.ALWAYS;
        else
            this.vscrollbar_policy = Gtk.PolicyType.NEVER;
        
        Tweener.removeTweens(this);
        Tweener.addTween(this, { opacity: 255,
                                 time: HELPER_ANIMATION_TIME,
                                 transition: 'easeOutQuad',
                                 onComplete: null });
    },
    
    hideHelp: function() {
        Tweener.removeTweens(this);
        Tweener.addTween(this, { opacity: 0,
                                 time: HELPER_ANIMATION_TIME,
                                 transition: 'easeOutQuad',
                                 onComplete: this.hide.bind(this) });
        
    }
});

const getActor = function(object) {
    return GS_VERSION < '3.33.0' ? object.actor : object;
};

const DrawingMenu = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingMenu',
    
    _init: function(area, monitor) {
        this.area = area;
        let side = Clutter.get_default_text_direction() == Clutter.TextDirection.RTL ? St.Side.RIGHT : St.Side.LEFT;
        this.menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0.25, side);
        this.menuManager = new PopupMenu.PopupMenuManager(GS_VERSION < '3.33.0' ? { actor: this.area } : this.area);
        this.menuManager.addMenu(this.menu);
        
        Main.layoutManager.uiGroup.add_actor(this.menu.actor);
        this.menu.actor.add_style_class_name('background-menu draw-on-your-screen-menu');
        this.menu.actor.set_style('max-height:' + monitor.height + 'px;');
        this.menu.actor.hide();
        this.hasSeparators = monitor.height >= 750;
        
        // do not close the menu on item activated
        this.menu.itemActivated = () => {};
        this.menu.connect('open-state-changed', this._onMenuOpenStateChanged.bind(this));
        
        // Case where the menu is closed (escape key) while the save entry clutter_text is active:
        // St.Entry clutter_text set the DEFAULT cursor on leave event with a delay and
        // overrides the cursor set by area.updatePointerCursor().
        // In order to update drawing cursor on menu closed, we need to leave the saveEntry before closing menu.
        // Since escape key press event can't be captured easily, the job is done in the menu close function.
        let menuCloseFunc = this.menu.close;
        this.menu.close = (animate) => {
            if (this.saveDrawingSubMenu && this.saveDrawingSubMenu.isOpen)
                this.saveDrawingSubMenu.close();
            menuCloseFunc.bind(this.menu)(animate);
        };
        
        this.colorIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(COLOR_ICON_PATH) });
        this.strokeIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(STROKE_ICON_PATH) });
        this.fillIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(FILL_ICON_PATH) });
        this.fillRuleNonzeroIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(FILLRULE_NONZERO_ICON_PATH) });
        this.fillRuleEvenoddIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(FILLRULE_EVENODD_ICON_PATH) });
        this.linejoinIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(LINEJOIN_ICON_PATH) });
        this.linecapIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(LINECAP_ICON_PATH) });
        this.fullLineIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(FULL_LINE_ICON_PATH) });
        this.dashedLineIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(DASHED_LINE_ICON_PATH) });
    },
    
    disable: function() {
        this.menuManager.removeMenu(this.menu);
        Main.layoutManager.uiGroup.remove_actor(this.menu.actor);
        this.menu.destroy();
    },
    
    _onMenuOpenStateChanged: function(menu, open) {
        if (open) {
            this.area.setPointerCursor('DEFAULT');
        } else {
            this.area.updatePointerCursor();
            // actionMode has changed, set previous actionMode in order to keep internal shortcuts working
            this.area.updateActionMode();
            this.area.grab_key_focus();
        }
    },
    
    popup: function() {
        if (this.menu.isOpen) {
            this.close();
        } else {
            this.open();
            this.menu.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
        }
    },
    
    open: function(x, y) {
        if (this.menu.isOpen)
            return;
        if (x === undefined || y === undefined)
            [x, y] = [this.area.monitor.x + this.area.monitor.width / 2, this.area.monitor.y + this.area.monitor.height / 2];
        this._redisplay();
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        let monitor = this.area.monitor;
        this.menu._arrowAlignment = (y - monitor.y) / monitor.height;
        this.menu.open(BoxPointer.PopupAnimation.NONE);
        this.menuManager.ignoreRelease();
    },
    
    close: function() {
        if (this.menu.isOpen)
            this.menu.close();
    },
    
    _redisplay: function() {
        this.menu.removeAll();
        
        this.menu.addAction(_("Undo"), this.area.undo.bind(this.area), 'edit-undo-symbolic');
        this.menu.addAction(_("Redo"), this.area.redo.bind(this.area), 'edit-redo-symbolic');
        this.menu.addAction(_("Erase"), this.area.deleteLastElement.bind(this.area), 'edit-clear-all-symbolic');
        this.menu.addAction(_("Smooth"), this.area.smoothLastElement.bind(this.area), 'format-text-strikethrough-symbolic');
        this._addSeparator(this.menu);
        
        this._addSubMenuItem(this.menu, 'document-edit-symbolic', ToolNames, this.area, 'currentTool', this._updateSectionVisibility.bind(this));
        this._addColorSubMenuItem(this.menu);
        this.fillItem = this._addSwitchItem(this.menu, _("Fill"), this.strokeIcon, this.fillIcon, this.area, 'fill', this._updateSectionVisibility.bind(this));
        this.fillSection = new PopupMenu.PopupMenuSection();
        this.fillSection.itemActivated = () => {};
        this.fillRuleItem = this._addSwitchItem(this.fillSection, _("Evenodd"), this.fillRuleNonzeroIcon, this.fillRuleEvenoddIcon, this.area, 'currentEvenodd');
        this.menu.addMenuItem(this.fillSection);
        this._addSeparator(this.menu);
        
        let lineSection = new PopupMenu.PopupMenuSection();
        this._addSliderItem(lineSection, this.area, 'currentLineWidth');
        this._addSubMenuItem(lineSection, this.linejoinIcon, LineJoinNames, this.area, 'currentLineJoin');
        this._addSubMenuItem(lineSection, this.linecapIcon, LineCapNames, this.area, 'currentLineCap');
        this._addSwitchItem(lineSection, _("Dashed"), this.fullLineIcon, this.dashedLineIcon, this.area, 'dashedLine');
        this._addSeparator(lineSection);
        this.menu.addMenuItem(lineSection);
        lineSection.itemActivated = () => {};
        this.lineSection = lineSection;
        
        let fontSection = new PopupMenu.PopupMenuSection();
        let FontGenericNamesCopy = Object.create(FontGenericNames);
        FontGenericNamesCopy[0] = this.area.currentThemeFontFamily;
        this._addSubMenuItem(fontSection, 'font-x-generic-symbolic', FontGenericNamesCopy, this.area, 'currentFontGeneric');
        this._addSubMenuItem(fontSection, 'format-text-bold-symbolic', FontWeightNames, this.area, 'currentFontWeight');
        this._addSubMenuItem(fontSection, 'format-text-italic-symbolic', FontStyleNames, this.area, 'currentFontStyle');
        this._addSwitchItem(fontSection, _("Right aligned"), 'format-justify-left-symbolic', 'format-justify-right-symbolic', this.area, 'currentTextRightAligned');
        this._addSeparator(fontSection);
        this.menu.addMenuItem(fontSection);
        fontSection.itemActivated = () => {};
        this.fontSection = fontSection;
        
        let manager = Extension.manager;
        this._addSimpleSwitchItem(this.menu, _("Hide panel and dock"), manager.hiddenList ? true : false, manager.togglePanelAndDockOpacity.bind(manager));
        this._addSimpleSwitchItem(this.menu, _("Add a drawing background"), this.area.hasBackground, this.area.toggleBackground.bind(this.area));
        this._addSimpleSwitchItem(this.menu, _("Add a grid overlay"), this.area.hasGrid, this.area.toggleGrid.bind(this.area));
        this._addSimpleSwitchItem(this.menu, _("Square drawing area"), this.area.isSquareArea, this.area.toggleSquareArea.bind(this.area));
        this._addSeparator(this.menu);
        
        this._addDrawingNameItem(this.menu);
        this._addOpenDrawingSubMenuItem(this.menu);
        this._addSaveDrawingSubMenuItem(this.menu);
        
        this.menu.addAction(_("Save drawing as a SVG file"), this.area.saveAsSvg.bind(this.area), 'image-x-generic-symbolic');
        this.menu.addAction(_("Edit style"), manager.openUserStyleFile.bind(manager), 'document-page-setup-symbolic');
        this.menu.addAction(_("Show help"), () => { this.close(); this.area.toggleHelp(); }, 'preferences-desktop-keyboard-shortcuts-symbolic');
        
        this._updateSectionVisibility();
    },
    
    _updateSectionVisibility: function() {
        if (this.area.currentTool != Shapes.TEXT) {
            this.lineSection.actor.show();
            this.fontSection.actor.hide();
            this.fillItem.setSensitive(true);
            this.fillSection.setSensitive(true);
        } else {
            this.lineSection.actor.hide();
            this.fontSection.actor.show();
            this.fillItem.setSensitive(false);
            this.fillSection.setSensitive(false);
        }
        
        if (this.area.fill)
            this.fillSection.actor.show();
        else
            this.fillSection.actor.hide();
    },
    
    _addSwitchItem: function(menu, label, iconFalse, iconTrue, target, targetProperty, onToggled) {
        let item = new PopupMenu.PopupSwitchMenuItem(label, target[targetProperty]);
        
        item.icon = new St.Icon({ style_class: 'popup-menu-icon' });
        getActor(item).insert_child_at_index(item.icon, 1);
        let icon = target[targetProperty] ? iconTrue : iconFalse;
        if (icon && icon instanceof GObject.Object && GObject.type_is_a(icon, Gio.Icon))
            item.icon.set_gicon(icon);
        else if (icon)
            item.icon.set_icon_name(icon);
        
        item.connect('toggled', (item, state) => {
            target[targetProperty] = state;
            let icon = target[targetProperty] ? iconTrue : iconFalse;
            if (icon && icon instanceof GObject.Object && GObject.type_is_a(icon, Gio.Icon))
                item.icon.set_gicon(icon);
            else if (icon)
                item.icon.set_icon_name(icon);
            if (onToggled)
                onToggled();
        });
        menu.addMenuItem(item);
        return item;
    },
    
    _addSimpleSwitchItem: function(menu, label, active, onToggled) {
        let item = new PopupMenu.PopupSwitchMenuItem(label, active);
        item.connect('toggled', onToggled);
        menu.addMenuItem(item);
    },
    
    _addSliderItem: function(menu, target, targetProperty) {
        let item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        let label = new St.Label({ text: _("%d px").format(target[targetProperty]), style_class: 'draw-on-your-screen-menu-slider-label' });
        let slider = new Slider.Slider(target[targetProperty] / 50);
        
        if (GS_VERSION < '3.33.0') {
            slider.connect('value-changed', (slider, value, property) => {
                target[targetProperty] = Math.max(Math.round(value * 50), 0);
                label.set_text(target[targetProperty] + " px");
                if (target[targetProperty] === 0)
                    label.add_style_class_name(Extension.WARNING_COLOR_STYLE_CLASS_NAME);
                else
                    label.remove_style_class_name(Extension.WARNING_COLOR_STYLE_CLASS_NAME);
            });
        } else {
            slider.connect('notify::value', () => {
                target[targetProperty] = Math.max(Math.round(slider.value * 50), 0);
                label.set_text(target[targetProperty] + " px");
                if (target[targetProperty] === 0)
                    label.add_style_class_name(Extension.WARNING_COLOR_STYLE_CLASS_NAME);
                else
                    label.remove_style_class_name(Extension.WARNING_COLOR_STYLE_CLASS_NAME);
            });
        }
        
        getActor(slider).x_expand = true;
        getActor(item).add_child(getActor(slider));
        getActor(item).add_child(label);
        if (slider.onKeyPressEvent)
            getActor(item).connect('key-press-event', slider.onKeyPressEvent.bind(slider));
        menu.addMenuItem(item);
    },
    
    _addSubMenuItem: function(menu, icon, obj, target, targetProperty, callback) {
        let item = new PopupMenu.PopupSubMenuMenuItem(_(obj[target[targetProperty]]), icon ? true : false);
        if (icon && icon instanceof GObject.Object && GObject.type_is_a(icon, Gio.Icon))
            item.icon.set_gicon(icon);
        else if (icon)
            item.icon.set_icon_name(icon);
        
        item.menu.itemActivated = () => {
            item.menu.close();
        };
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (let i in obj) {
                let text;
                if (targetProperty == 'currentFontGeneric')
                    text = `<span font_family="${obj[i]}">${_(obj[i])}</span>`;
                else if (targetProperty == 'currentFontWeight')
                    text = `<span font_weight="${i}">${_(obj[i])}</span>`;
                else if (targetProperty == 'currentFontStyle')
                    text = `<span font_style="${obj[i].toLowerCase()}">${_(obj[i])}</span>`;
                else
                    text = _(obj[i]);
                
                let iCaptured = Number(i);
                let subItem = item.menu.addAction(text, () => {
                    item.label.set_text(_(obj[iCaptured]));
                    target[targetProperty] = iCaptured;
                    if (callback)
                        callback();
                });
                
                subItem.label.get_clutter_text().set_use_markup(true);
                
                // change the display order of tools
                if (obj == ToolNames && i == Shapes.POLYGON)
                    item.menu.moveMenuItem(subItem, 4);
                else if (obj == ToolNames && i == Shapes.POLYLINE)
                    item.menu.moveMenuItem(subItem, 5);
            }
            return GLib.SOURCE_REMOVE;
        });
        menu.addMenuItem(item);
    },
    
    _addColorSubMenuItem: function(menu) {
        let item = new PopupMenu.PopupSubMenuMenuItem(_("Color"), true);
        item.icon.set_gicon(this.colorIcon);
        item.icon.set_style(`color:${this.area.currentColor.to_string().slice(0, 7)};`);
        
        item.menu.itemActivated = () => {
            item.menu.close();
        };
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (let i = 1; i < this.area.colors.length; i++) {
                let text = this.area.colors[i].to_string();
                let iCaptured = i;
                let colorItem = item.menu.addAction(text, () => {
                    this.area.currentColor = this.area.colors[iCaptured];
                    item.icon.set_style(`color:${this.area.currentColor.to_string().slice(0, 7)};`);
                });
                colorItem.label.get_clutter_text().set_use_markup(true);
                // Foreground color markup is not displayed since 3.36, use style instead but the transparency is lost.
                colorItem.label.set_style(`color:${this.area.colors[i].to_string().slice(0, 7)};`);
            }
            return GLib.SOURCE_REMOVE;
        });
        menu.addMenuItem(item);
    },
    
    _addDrawingNameItem: function(menu) {
        this.drawingNameMenuItem = new PopupMenu.PopupMenuItem('', { reactive: false, activate: false });
        this.drawingNameMenuItem.setSensitive(false);
        menu.addMenuItem(this.drawingNameMenuItem);
        this._updateDrawingNameMenuItem();
    },
    
    _updateDrawingNameMenuItem: function() {
        getActor(this.drawingNameMenuItem).visible = this.area.jsonName ? true : false;
        if (this.area.jsonName) {
            let prefix = this.area.drawingContentsHasChanged ? "* " : "";
            this.drawingNameMenuItem.label.set_text(`<i>${prefix}${this.area.jsonName}</i>`);
            this.drawingNameMenuItem.label.get_clutter_text().set_use_markup(true);
        }
    },
    
    _addOpenDrawingSubMenuItem: function(menu) {
        let item = new PopupMenu.PopupSubMenuMenuItem(_("Open drawing"), true);
        this.openDrawingSubMenuItem = item;
        this.openDrawingSubMenu = item.menu;
        item.icon.set_icon_name('document-open-symbolic');
        
        item.menu.itemActivated = () => {
            item.menu.close();
        };
        
        item.menu.openOld = item.menu.open;
        item.menu.open = (animate) => {
            if (!item.menu.isOpen)
                this._populateOpenDrawingSubMenu();
            item.menu.openOld();
        };
        
        menu.addMenuItem(item);
    },
    
    _populateOpenDrawingSubMenu: function() {
        this.openDrawingSubMenu.removeAll();
        let jsonFiles = getJsonFiles();
        jsonFiles.forEach(file => {
            let item = this.openDrawingSubMenu.addAction(`<i>${file.displayName}</i>`, () => {
                this.area.loadJson(file.name);
                this._updateDrawingNameMenuItem();
                this._updateSaveDrawingSubMenuItemSensitivity();
            });
            item.label.get_clutter_text().set_use_markup(true);
            
            let expander = new St.Bin({
                style_class: 'popup-menu-item-expander',
                x_expand: true,
            });
            getActor(item).add_child(expander);
            
            let deleteButton = new St.Button({ style_class: 'draw-on-your-screen-menu-delete-button',
                                               child: new St.Icon({ icon_name: 'edit-delete-symbolic',
                                                                    style_class: 'popup-menu-icon',
                                                                    x_align: Clutter.ActorAlign.END }) });
            getActor(item).add_child(deleteButton);
            
            deleteButton.connect('clicked', () => {
                file.delete();
                item.destroy();
            });
        });
        
        this.openDrawingSubMenuItem.setSensitive(!this.openDrawingSubMenu.isEmpty());
    },
    
    _addSaveDrawingSubMenuItem: function(menu) {
        let item = new PopupMenu.PopupSubMenuMenuItem(_("Save drawing"), true);
        this.saveDrawingSubMenuItem = item;
        this._updateSaveDrawingSubMenuItemSensitivity();
        this.saveDrawingSubMenu = item.menu;
        item.icon.set_icon_name('document-save-symbolic');
        
        item.menu.itemActivated = () => {
            item.menu.close();
        };
        
        item.menu.openOld = item.menu.open;
        item.menu.open = (animate) => {
            if (!item.menu.isOpen)
                this._populateSaveDrawingSubMenu();
            item.menu.openOld();
        };
        menu.addMenuItem(item);
    },
    
    _updateSaveDrawingSubMenuItemSensitivity: function() {
        this.saveDrawingSubMenuItem.setSensitive(this.area.elements.length > 0);
    },
    
    _populateSaveDrawingSubMenu: function() {
        this.saveDrawingSubMenu.removeAll();
        let saveEntry = new DrawingMenuEntry({ initialTextGetter: getDateString,
                                                entryActivateCallback: (text) => {
                                                    this.area.saveAsJsonWithName(text);
                                                    this.saveDrawingSubMenu.toggle();
                                                    this._updateDrawingNameMenuItem();
                                                },
                                                invalidStrings: [Me.metadata['persistent-file-name'], '/'],
                                                primaryIconName: 'insert-text' });
        this.saveDrawingSubMenu.addMenuItem(saveEntry.item);
    },
    
    _addSeparator: function(menu) {
        if (this.hasSeparators) {
            let separatorItem = new PopupMenu.PopupSeparatorMenuItem(' ');
            getActor(separatorItem).add_style_class_name('draw-on-your-screen-menu-separator-item');
            menu.addMenuItem(separatorItem);
        }
    }
});

// based on searchItem.js, https://github.com/leonardo-bartoli/gnome-shell-extension-Recents
const DrawingMenuEntry = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingMenuEntry',
    
    _init: function(params) {
        this.params = params;
        this.item = new PopupMenu.PopupBaseMenuItem({ style_class: 'draw-on-your-screen-menu-entry-item',
                                                      activate: false,
                                                      reactive: true,
                                                      can_focus: false });
        
        this.itemActor = GS_VERSION < '3.33.0' ? this.item.actor : this.item;
        
        this.entry = new St.Entry({
            style_class: 'search-entry draw-on-your-screen-menu-entry',
            track_hover: true,
            reactive: true,
            can_focus: true,
            x_expand: true
        });
        
        this.entry.set_primary_icon(new St.Icon({ style_class: 'search-entry-icon',
                                                  icon_name: this.params.primaryIconName }));
        
        this.entry.clutter_text.connect('text-changed', this._onTextChanged.bind(this));
        this.entry.clutter_text.connect('activate', this._onTextActivated.bind(this));
        
        this.clearIcon = new St.Icon({
            style_class: 'search-entry-icon',
            icon_name: 'edit-clear-symbolic'
        });
        this.entry.connect('secondary-icon-clicked', this._reset.bind(this));
        
        getActor(this.item).add_child(this.entry);
        getActor(this.item).connect('notify::mapped', (actor) => {
            if (actor.mapped) {
                this.entry.set_text(this.params.initialTextGetter());
                this.entry.clutter_text.grab_key_focus();
            }
        });
    },
    
    _setError: function(hasError) {
        if (hasError)
            this.entry.add_style_class_name('draw-on-your-screen-menu-entry-error');
        else
            this.entry.remove_style_class_name('draw-on-your-screen-menu-entry-error');
    },
    
    _reset: function() {
        this.entry.text = '';
        this.entry.clutter_text.set_cursor_visible(true);
        this.entry.clutter_text.set_selection(0, 0);
        this._setError(false);
    },
    
    _onTextActivated: function(clutterText) {
        let text = clutterText.get_text();
        if (text.length == 0)
            return;
        if (this._getIsInvalid())
            return;
        this._reset();
        this.params.entryActivateCallback(text);
    },
    
    _onTextChanged: function(clutterText) {
        let text = clutterText.get_text();
        this.entry.set_secondary_icon(text.length ? this.clearIcon : null);
        
        if (text.length)
            this._setError(this._getIsInvalid());
    },
    
    _getIsInvalid: function() {
        for (let i = 0; i < this.params.invalidStrings.length; i++) {
            if (this.entry.text.indexOf(this.params.invalidStrings[i]) != -1)
                return true;
        }
        
        return false;
    }
});


