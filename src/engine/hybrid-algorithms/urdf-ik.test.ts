// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { solveIk } from "@/engine/hybrid-algorithms/urdf-ik";

/**
 * The CCD solver, driven against REAL urdf-loader robots — the whole point of it is the
 * geometry of a parsed URDF chain, so a fake robot would test nothing.
 *
 * jsdom is REQUIRED: URDFLoader.parse() uses DOMParser.
 */

/**
 * A planar arm: two unit segments turning about z, with a fixed tool on the end.
 *
 * NOTE how the length lives in the JOINT origins, not in the links: a link is a frame,
 * and what puts the tool 2 units from the base is the elbow sitting 1 along x from the
 * shoulder and the tool 1 along x from the elbow. The fixed wrist gives the chain a tip
 * that is not itself a joint frame, which is what a real arm's flange looks like.
 */
const PLANAR_ARM = `<?xml version="1.0"?>
<robot name="planar_arm">
  <link name="base_link"/>
  <link name="upper_arm"/>
  <link name="forearm"/>
  <link name="tool"/>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/>
    <child link="upper_arm"/>
    <origin xyz="0 0 0" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="2"/>
  </joint>
  <joint name="elbow" type="revolute">
    <parent link="upper_arm"/>
    <child link="forearm"/>
    <origin xyz="1 0 0" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="2"/>
  </joint>
  <joint name="wrist" type="fixed">
    <parent link="forearm"/>
    <child link="tool"/>
    <origin xyz="1 0 0" rpy="0 0 0"/>
  </joint>
</robot>`;

/** The same arm with the shoulder barely able to turn. */
const STIFF_SHOULDER_ARM = PLANAR_ARM.replace(
  '<limit lower="-3.14" upper="3.14" effort="10" velocity="2"/>',
  '<limit lower="0" upper="0.2" effort="10" velocity="2"/>',
);

/** The same arm with a slider on the end, to exercise the prismatic branch. */
const SLIDER_ARM = `<?xml version="1.0"?>
<robot name="slider_arm">
  <link name="base_link"/>
  <link name="carriage"/>
  <joint name="rail" type="prismatic">
    <parent link="base_link"/>
    <child link="carriage"/>
    <origin xyz="0 0 0" rpy="0 0 0"/>
    <axis xyz="1 0 0"/>
    <limit lower="0" upper="2" effort="10" velocity="1"/>
  </joint>
</robot>`;

function parse(urdf: string): URDFRobot {
  const loader = new URDFLoader();
  loader.parseVisual = false;
  loader.parseCollision = false;
  const robot = loader.parse(urdf);
  robot.updateMatrixWorld(true);
  return robot;
}

function tipOf(robot: URDFRobot, linkName: string): THREE.Vector3 {
  return robot.links[linkName].getWorldPosition(new THREE.Vector3());
}

describe("urdf-ik: CCD over a URDF chain", () => {
  it("reaches a point inside the workspace and reports the joints that get there", () => {
    const robot = parse(PLANAR_ARM);
    // Straight out along x the arm spans 2; fold it to a point it can just reach.
    const target = { x: 1.2, y: 0.9, z: 0 };

    const result = solveIk(robot, target);

    expect(result.converged).toBe(true);
    expect(result.error).toBeLessThan(1e-3);
    expect(tipOf(robot, "tool").distanceTo(new THREE.Vector3(1.2, 0.9, 0))).toBeLessThan(1e-3);
    // Both joints of the chain are reported, by their URDF names.
    expect(Object.keys(result.jointValues).sort()).toEqual(["elbow", "shoulder"]);
  });

  it("gets as close as it can to a point outside the workspace, without claiming to reach it", () => {
    const robot = parse(PLANAR_ARM);

    // The arm is 2 long; 5 away is out of reach.
    const result = solveIk(robot, { x: 5, y: 0, z: 0 });

    expect(result.converged).toBe(false);
    // Fully extended, so the tip sits 2 from the origin and 3 short of the target.
    expect(result.error).toBeCloseTo(3, 1);
  });

  it("slides a prismatic joint along its axis instead of turning it", () => {
    const robot = parse(SLIDER_ARM);

    const result = solveIk(robot, { x: 1.5, y: 0, z: 0 });

    expect(result.jointValues["rail"]).toBeCloseTo(1.5, 3);
    expect(tipOf(robot, "carriage").x).toBeCloseTo(1.5, 3);
  });

  it("respects a joint's limits", () => {
    const robot = parse(STIFF_SHOULDER_ARM);

    const result = solveIk(robot, { x: 0, y: 1.5, z: 0 });

    // The shoulder cannot turn far enough to point the arm at +y, so it stops at its
    // upper limit rather than sailing past it.
    expect(result.jointValues["shoulder"]).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(result.jointValues["shoulder"]).toBeGreaterThanOrEqual(0);
    expect(result.converged).toBe(false);
  });

  it("solves for a named tip link when one is asked for", () => {
    const robot = parse(PLANAR_ARM);

    // Driving the FOREARM, not the tool: its frame sits one unit from the base, so a
    // point one unit away in y is reachable by turning the shoulder alone.
    const result = solveIk(robot, { x: 0, y: 1, z: 0 }, { tipLinkName: "forearm" });

    expect(result.converged).toBe(true);
    expect(tipOf(robot, "forearm").distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-3);
    // The elbow is in the chain (the forearm hangs off it) but turning it pivots that
    // frame about its own origin, which cannot move it — so it is left alone.
    expect(result.jointValues["elbow"]).toBe(0);
  });

  it("reports nothing to solve for a robot with no movable joints", () => {
    const robot = parse(`<?xml version="1.0"?><robot name="lonely"><link name="base_link"/></robot>`);

    const result = solveIk(robot, { x: 1, y: 0, z: 0 });

    expect(result.converged).toBe(false);
    expect(result.jointValues).toEqual({});
  });
});
