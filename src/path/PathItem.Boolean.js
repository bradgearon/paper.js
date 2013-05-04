/*
 * Paper.js - The Swiss Army Knife of Vector Graphics Scripting.
 * http://paperjs.org/
 *
 * Copyright (c) 2011 - 2013, Juerg Lehni & Jonathan Puckey
 * http://lehni.org/ & http://jonathanpuckey.com/
 *
 * Distributed under the MIT license. See LICENSE file for details.
 *
 * All rights reserved.
 */

/*
 * Boolean Geometric Path Operations
 *
 * This is mostly written for clarity and compatibility, not optimised for
 * performance, and has to be tested heavily for stability.
 *
 * Supported
 *  - paperjs Path and CompoundPath objects
 *  - Boolean Union
 *  - Boolean Intersection
 *  - Boolean Subtraction
 *  - Resolving a self-intersecting Path
 *
 * Not supported yet
 *  - Boolean operations on self-intersecting Paths
 *  - Paths are clones of each other that ovelap exactly on top of each other!
 *
 * @author Harikrishnan Gopalakrishnan
 * http://hkrish.com/playground/paperjs/booleanStudy.html
 */

PathItem.inject(new function() {

	function splitPath(intersections, collectOthers) {
		// Sort intersections by paths ids, curve index and parameter, so we
		// can loop through all intersections, divide paths and never need to
		// readjust indices.
		intersections.sort(function(loc1, loc2) {
			var path1 = loc1.getPath(),
				path2 = loc2.getPath();
			return path1 === path2
					// We can add parameter (0 <= t <= 1) to index (a integer)
					// to compare both at the same time
					? (loc1.getIndex() + loc1.getParameter())
						- (loc2.getIndex() + loc2.getParameter())
					: path1._id - path2._id;
		});
		var others = collectOthers && [];
		for (var i = intersections.length - 1; i >= 0; i--) {
			var loc = intersections[i],
				other = loc.getIntersection(),
				curve = loc.divide(),
				// When the curve doesn't need to be divided since t = 0, 1,
				// #divide() returns null and we can use the existing segment.
				segment = curve && curve.getSegment1() || loc.getSegment();
			if (others)
				others.push(other);
			other.__segment = segment;
			segment._ixPair = other;
		}
		return others;
	}

	/**
	 * To deal with a HTML canvas requirement where CompoundPaths' child contours
	 * has to be of different winding direction for correctly filling holes.
	 * But if some individual countours are disjoint, i.e. islands, we have to
	 * reorient them so that
	 *   the holes have opposit winding direction (already handled by paperjs)
	 *   islands has to have same winding direction (as the first child of the path)
	 *
	 * Does NOT handle selfIntersecting CompoundPaths.
	 *
	 * @param  {CompoundPath} path - Input CompoundPath, Note: This path could be modified if need be.
	 * @return {boolean}	  the winding direction of the base contour(true if clockwise)
	 */
	function reorientCompoundPath(path) {
		if (!(path instanceof CompoundPath))
			return path.isClockwise();
		var children = path._children,
			length = children.length,
			bounds = new Array(length),
			counters = new Array(length),
			clockwise = children[0].isClockwise();
		for (var i = 0; i < length; i++) {
			bounds[i] = children[i].getBounds();
			counters[i] = 0;
		}
		for (var i = 0; i < length; i++) {
			for (var j = 1; j < length; j++) {
				if (i !== j && bounds[i].contains(bounds[j]))
					counters[j]++;
			}
		}
		// Omit the first child
		for (var i = 1; i < length; i++) {
			if (counters[i] % 2 === 0) {
				children[i].setClockwise(clockwise);
			}
		}
		return clockwise;
	}

	function computeBoolean(path1, path2, operator, subtract, _cache) {
		var ixs, path1Id, path2Id;
		// We do not modify the operands themselves
		// The result might not belong to the same type
		// i.e. subtraction(A:Path, B:Path):CompoundPath etc.
		var _path1 = path1.clone(),
			_path2 = path2.clone(),
			path1Id = _path1.id,
			path2Id = _path2.id,
			path1Clockwise = reorientCompoundPath(_path1),
			path2Clockwise = reorientCompoundPath(_path2),
			// Calculate all the intersections
			intersections = _cache && _cache.intersections
					|| _path1.getIntersections(_path2);
		// if we have a empty _cache object as an operand, skip calculating
		// boolean and cache the intersections
		if (_cache && !_cache.intersections) {
			// TODO: Don't we need to clear up and remove _path1 & _path2 again?
			return _cache.intersections = intersections;
		}
		// Now split intersections on both curves, by asking the first call to
		// collect the 'other' intersections for us and passing that on to the
		// second call.
		splitPath(splitPath(intersections, true));
		// Do operator specific calculations before we begin
		if (subtract) {
			_path2.reverse();
			path2Clockwise = !path2Clockwise;
		}

		var paths = [],
			nodes = [],
			result = new CompoundPath(),
			push = paths.push;
		if (_path1 instanceof CompoundPath) {
			push.apply(paths, _path1._children);
		} else {
			paths.push(_path1);
		}
		if (_path2 instanceof CompoundPath) {
			push.apply(paths, _path2._children);
		} else {
			paths.push(_path2);
		}
		// Step 1: Discard invalid links according to the boolean operator
		for (var i = 0, l = paths.length; i < l; i++) {
			var path = paths[i],
				insidePath1 = false,
				insidePath2 = false,
				thisId = path.parent instanceof CompoundPath
						? path.parent.id : path.id,
				clockwise = path.isClockwise(),
				segments = path._segments;
			for (var j = 0, k = segments.length; j < k; j++) {
				var segment = segments[j],
					curve = segment.getCurve(),
					midPoint = curve.getPoint(0.5);
				if (thisId !== path1Id) {
					insidePath1 = _path1.contains(midPoint)
							&& (clockwise === path1Clockwise || subtract
									|| !testOnCurve(_path1, midPoint));
				}
				if (thisId !== path2Id) {
					insidePath2 = _path2.contains(midPoint)
							&& (clockwise === path2Clockwise
									|| !testOnCurve(_path2, midPoint));
				}
				if (operator(thisId === path1Id, insidePath1, insidePath2)) {
					curve._INVALID = true;
					// markPoint(midPoint, '+');
				}
			}
			nodes = nodes.concat(path._segments);
		}

		// Step 2: Retrieve the resulting paths from the graph
		for (var i = 0, l = nodes.length; i < l; i++) {
			var node = nodes[i];
			if (node.curve._INVALID || node._visited) { continue; }
			var path = node.path,
				thisId = (path.parent instanceof CompoundPath)? path.parent.id : path.id,
				nuPath = new Path(),
				firstNode = null,
				firstNode_ix = null;
			if (node.previous.curve._INVALID) {
				node.setHandleIn(node._ixPair
						? node._ixPair.getIntersection().__segment._handleIn
						: Point.create(0, 0));
			}
			while (node && !node._visited && (node !== firstNode && node !== firstNode_ix)) {
				node._visited = true;
				firstNode = firstNode || node;
				firstNode_ix = !firstNode_ix && firstNode._ixPair
						? firstNode._ixPair.getIntersection().__segment
						: firstNode_ix;
				// node._ixPair is this node's intersection CurveLocation object
				// node._ixPair.getIntersection() is the other CurveLocation object this node intersects with
				var nextNode = (node._ixPair && node.curve._INVALID)? node._ixPair.getIntersection().__segment : node;
				if (node._ixPair) {
					nextNode._visited = true;
					nuPath.add(new Segment(node._point, node._handleIn,
							nextNode._handleOut));
					node = nextNode;
				} else {
					nuPath.add(node);
				}
				node = node.next;
			}
			// Avoid stray segments and incomplete paths
			if (nuPath.segments.length > 2 || !nuPath.curves[0].isLinear()) {
				nuPath.closed = true;
				result.addChild(nuPath, true);
			}
		}
		// Delete the proxies
		_path1.remove();
		_path2.remove();
		// And then, we are done.
		return result.reduce();
	}

	function testOnCurve(path, point) {
		var curves = path.getCurves(),
			bounds = path.getBounds();
		if (bounds.contains(point)) {
			for (var i = 0, l = curves.length; i < l; i++) {
				var curve = curves[i];
				if (curve.getBounds().contains(point)
						&& curve.getParameterOf(point))
					return true;
			}
		}
		return false;
	}

	// A boolean operator is a binary operator function of the form
	// function(isPath1, isInPath1, isInPath2)
	//
	// Operators return true if a curve in the operands is to be removed,
	// and they aare called for each curve segment in the graph after all the
	// intersections between the operands are calculated and curves in the
	// operands were split at intersections.
	//
	//  The boolean operator return a Boolean value indicating whether to
	// keep the curve or not.
	//  return true - discard the curve
	//  return false - keep the curve

	return {
		unite: function(path, _cache) {
			return computeBoolean(this, path,
					function(isPath1, isInPath1, isInPath2) {
						return isInPath1 || isInPath2;
					}, false, _cache);
		},

		intersect: function(path, _cache) {
			return computeBoolean(this, path,
					function(isPath1, isInPath1, isInPath2) {
						return !(isInPath1 || isInPath2);
					}, false, _cache);
		},

		subtract: function(path, _cache) {
			return computeBoolean(this, path,
					function(isPath1, isInPath1, isInPath2) {
						return isPath1 && isInPath2 || !isPath1 && !isInPath1;
					}, true, _cache);
		},

		// Compound boolean operators combine the basic boolean operations such
		// as union, intersection, subtract etc. 
		// TODO: cache the split objects and find a way to properly clone them!
		// a.k.a. eXclusiveOR
		exclude: function(path) {
			return new Group([this.subtract(path), path.subtract(this)]);
		},

		// Divide path1 by path2
		divide: function(path) {
			return new Group([this.subtract(path), this.intersect(path)]);
		}
	};
});